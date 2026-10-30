// Verified league and federation history (#323), staff side. A league or federation is registered as a source, approved by the platform team, and either
// pulled over its live API or fed from an export file its staff upload. Everything it sends is STAGED here: staff match it to a player, merge it with what the
// player already recorded, and only then does it reach the player's career timeline, labelled with where it came from. The server decides who may do what.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Empty, ErrorBox, H1, H2, Loading, Screen, Seg, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { MenuField } from '../menu-field';
import { c } from '../theme';

const nice = (s) => String(s).replace(/_/g, ' ');
const LEVELS = ['grassroots', 'school', 'club', 'academy', 'regional', 'national', 'international', 'professional'].map((value) => ({ value, label: nice(value).replace(/^./, (x) => x.toUpperCase()) }));
const month = (s) => (s ? new Date(`${s}T12:00:00`).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }) : '');
const span = (r) => `${month(r.starts_on)} – ${r.ends_on ? month(r.ends_on) : 'Present'}`;
const when = (t) => (t ? new Date(t).toLocaleString() : '');
const say = (e) => (e?.details?.code === 'stale_version' ? 'This was changed somewhere else. Pull to reload, then try again.' : e?.details?.code === 'source_not_approved' ? 'This source has not been approved by the platform team (or is suspended).' : e?.details?.code === 'guardian_consent_required' ? 'A guardian has not given current consent for participation, so this cannot be decided yet.' : e?.message ?? 'Something went wrong');

// What each connection state honestly means. A feed is "live" only after a successful pull; a file source is never called live.
export const CONNECTION = {
  live: ['Live feed · last pull worked', c.mint], never_synced: ['Live feed · not pulled yet', c.sun], failed: ['Live feed · last pull failed', c.red], partial: ['Live feed · last pull partly worked', c.sun],
  file_only: ['Uploaded export files', c.violetSoft], not_approved: ['Not approved yet', c.sun],
};
const STATUS = { approved: ['Approved', c.mint], pending: ['Waiting for the platform team', c.sun], suspended: ['Suspended', c.red] };
const REC = { new: ['To review', c.sun], changed: ['Source changed it', c.orange ?? c.sun], disputed: ['Disputed by the player', c.red], withdrawn: ['Withdrawn by the source', c.red], accepted: ['Confirmed', c.mint], rejected: ['Rejected', c.violetSoft] };

function RegisterSource({ onClose, onDone, canPlatform }) {
  const bodies = useLoad(() => api.get('/federation/mine', { limit: 100 }).catch(() => []), []);
  return (
    <FormSheet visible onClose={onClose} title="Register a league or federation" submitLabel="Register"
      initial={{ kind: 'league', adapter: 'file_import' }}
      fields={[
        { key: 'name', label: 'Name', placeholder: 'As players know it' },
        { key: 'kind', label: 'What is it?', type: 'chips', options: [{ value: 'league', label: 'League' }, { value: 'federation', label: 'Federation' }] },
        { key: 'body_id', type: 'custom', render: ({ v, set }) => (
          <MenuField label={canPlatform ? 'Governing body (optional)' : 'Governing body you run'} value={v.body_id ?? ''} onChange={(x) => set('body_id', x || undefined)} placeholder={canPlatform ? 'None: the platform team runs it' : 'Choose'}
            options={[...(canPlatform ? [{ value: '', label: 'None: the platform team runs it' }] : []), ...(bodies.data ?? []).map((b) => ({ value: b.id, label: b.name, sub: nice(b.level) }))]}
            hint="Its registrars and admins run the source. Without one, only the platform team can." />) },
        { key: 'sport', label: 'Sport', type: 'sport', optional: true, hint: 'Leave empty for a multi-sport source; each record then names its sport.' },
        { key: 'adapter', label: 'How does it send records?', type: 'chips', options: [{ value: 'file_import', label: 'I upload its export file' }, { value: 'api_json', label: 'Live feed (the league has an API)' }], hint: 'A live feed needs real API access from the league. If you do not have it, upload their export file: it is labelled as an uploaded file, never as live.' },
        { key: 'endpoint_url', label: 'Feed address (https)', placeholder: 'https://…', input: 'url', show: (v) => v.adapter === 'api_json' },
        { key: 'token', label: 'Access token', type: 'secret', optional: true, show: (v) => v.adapter === 'api_json', hint: 'Stored encrypted and never shown again.' },
      ]}
      onSubmit={async (v) => {
        try {
          const body = { ...v }; delete body.body_id__pick;
          if (body.adapter === 'file_import') { delete body.endpoint_url; delete body.token; }
          await api.post('/history-sources', body); await onDone(); return 'Source registered';
        } catch (e) { throw new Error(say(e)); }
      }} />
  );
}

function ImportFile({ source, onClose, onDone }) {
  return (
    <FormSheet visible onClose={onClose} title={`Import a file for ${source.name}`} submitLabel="Stage records"
      initial={{ format: 'csv' }}
      fields={[
        { key: 'format', label: 'File type', type: 'chips', options: [{ value: 'csv', label: 'CSV' }, { value: 'json', label: 'JSON' }] },
        { key: 'files', label: 'Export file', type: 'files', documents: 'wide', max: 1, hint: 'Columns: external_ref, person_ref, person_name, licence_no, club, sport, season, starts_on, ends_on, position, level, jersey_no. Records are staged for review; nothing reaches a player until you confirm it.' },
      ]}
      onSubmit={async (v) => {
        try {
          const f = v.files?.[0];
          if (!f) throw new Error('Choose a file');
          const r = await api.post(`/history-sources/${source.id}/import`, { format: v.format, data: f.data });
          await onDone();
          return r.replayed ? 'That file was already imported' : `${r.created} new, ${r.updated} changed, ${r.unchanged} unchanged${r.failed ? `, ${r.failed} skipped` : ''}`;
        } catch (e) { throw new Error(say(e)); }
      }} />
  );
}

function AcceptSheet({ source, rec, onClose, onDone }) {
  const dups = rec.possible_duplicates ?? [];
  const needsLevel = !rec.competition_level;
  const picks = rec.candidates ?? [];
  return (
    <FormSheet visible onClose={onClose} title={`Confirm ${rec.club_name}`} submitLabel="Confirm and add to timeline"
      initial={{ reconcile: dups.length ? undefined : 'create', competition_level: rec.competition_level ?? undefined }}
      fields={[
        ...(rec.user ? [{ key: 'who', type: 'section', label: `Player: ${rec.user.display_name}` }] : [
          ...(picks.length ? [{ key: 'sugg', type: 'custom', render: ({ set, v }) => (
            <View style={{ gap: 6 }}>
              <T weight="800" size={13}>Players with the same name</T>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                {picks.map((p) => <Btn key={p.id} small title={`${p.display_name} · @${p.handle}`} color={v.user_id === p.id ? c.violet : c.paper} ink={v.user_id === p.id ? c.paper : c.ink} onPress={() => { set('user_id', p.id); set('user_id__pick', { id: p.id, name: p.display_name }); }} accessibilityLabel={`Pick ${p.display_name}`} />)}
              </View>
              <T size={12} color={c.mute}>A matching name only suggests a player. Confirm it is the right one before you accept.</T>
            </View>) }] : []),
          { key: 'user_id', label: 'Player', type: 'entity', entityKind: 'person', noun: 'player', hint: 'Search by name or handle.' },
        ]),
        { key: 'team_id', label: `Which club is “${rec.club_name}” on Gotmygame?`, type: 'entity', entityKind: 'team', noun: 'club or team', optional: true, hint: 'Optional. Remembered for this source, so the next record resolves by itself.' },
        ...(needsLevel ? [{ key: 'competition_level', label: 'Competition level (the source did not say)', type: 'chips', options: LEVELS }] : []),
        ...(dups.length ? [
          { key: 'sep', type: 'section', label: 'This player already has a similar entry' },
          { key: 'reconcile', label: 'What is it?', type: 'chips', options: [...dups.map((d) => ({ value: `merge:${d.id}`, label: `Same stint as ${d.club} (${span(d)})` })), { value: 'create', label: 'A separate stint' }] },
        ] : []),
        { key: 'note', label: 'Note for the history', optional: true },
      ]}
      onSubmit={async (v) => {
        try {
          const reconcile = v.reconcile?.startsWith('merge:') ? { mode: 'merge', membership_id: v.reconcile.slice(6) } : v.reconcile === 'create' ? { mode: 'create' } : undefined;
          await api.post(`/history-records/${rec.id}/review`, { decision: 'accept', row_version: rec.row_version, user_id: rec.user ? undefined : v.user_id, team_id: v.team_id || undefined, competition_level: v.competition_level || undefined, reconcile, note: v.note || undefined });
          await onDone(); return 'Confirmed. The player has been told.';
        } catch (e) { throw new Error(say(e)); }
      }} />
  );
}

function RecordCard({ source, rec, onChanged }) {
  const { toast } = useSession();
  const [sub, setSub] = useState(null);
  const [busy, setBusy] = useState(false);
  const [label, tone] = REC[rec.status];
  const run = async (body, msg) => { setBusy(true); try { await api.post(`/history-records/${rec.id}/review`, { row_version: rec.row_version, ...body }); await onChanged(); toast(msg); } catch (e) { toast(say(e)); } finally { setBusy(false); } };
  const person = [rec.person.name, rec.person.ref && `ID ${rec.person.ref}`, rec.person.licence_no && `licence ${rec.person.licence_no}`].filter(Boolean).join(' · ');
  return (
    <Card pad={14} accessibilityLabel={`${rec.club_name}, ${span(rec)}, ${label}`}>
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
        <Tag label={label} color={tone} />
        <Tag label={rec.via === 'feed' ? 'Live feed' : 'Uploaded file'} />
        {rec.version > 1 ? <Tag label={`Version ${rec.version}`} /> : null}
      </View>
      <T weight="800" size={16}>{rec.club_name}</T>
      <T size={13} color={c.mute}>{[span(rec), rec.sport, rec.season_label, rec.position, rec.competition_level && nice(rec.competition_level)].filter(Boolean).join(' · ')}</T>
      <T size={13} style={{ marginTop: 4 }}>From the source: {person || 'no identity sent'}</T>
      <T size={13} color={rec.user ? c.ink : c.sun} weight="700">{rec.user ? `Matched to ${rec.user.display_name} (${rec.match_method === 'identity' ? 'confirmed ID' : rec.match_method === 'licence' ? 'licence number' : 'chosen by staff'})` : rec.candidates?.length ? `Not matched. ${rec.candidates.length} player${rec.candidates.length === 1 ? '' : 's'} share the name.` : 'Not matched to a player yet'}</T>
      {rec.previous ? <T size={12} color={c.mute} style={{ marginTop: 4 }}>Before: {[rec.previous.club, month(rec.previous.starts_on) + ' – ' + (rec.previous.ends_on ? month(rec.previous.ends_on) : 'Present'), rec.previous.position].filter(Boolean).join(' · ')}</T> : null}
      {rec.possible_duplicates?.length ? <T size={12} color={c.mute} style={{ marginTop: 4 }}>Already on their timeline: {rec.possible_duplicates.map((d) => `${d.club} (${span(d)})`).join('; ')}</T> : null}
      {rec.decision_note ? <T size={12} color={c.mute} style={{ marginTop: 4 }}>Note: “{rec.decision_note}”</T> : null}

      <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        {['new', 'disputed'].includes(rec.status) ? <>
          <Btn small title="Confirm…" disabled={busy || rec.withdrawn} onPress={() => setSub('accept')} style={{ flex: 1 }} accessibilityLabel={`Confirm ${rec.club_name}`} />
          <Btn small title="Reject" color={c.paper} ink={c.red} disabled={busy} onPress={() => setSub('reject')} style={{ flex: 1 }} />
        </> : null}
        {rec.status === 'changed' ? <>
          <Btn small title="Apply the change" disabled={busy} loading={busy} onPress={() => run({ decision: 'apply_update' }, 'Timeline updated')} style={{ flex: 1 }} />
          <Btn small title="Keep as it was" color={c.paper} disabled={busy} onPress={() => run({ decision: 'keep_current' }, 'Kept')} style={{ flex: 1 }} />
        </> : null}
        {rec.status === 'withdrawn' ? <Btn small title="Remove the verification" color={c.paper} ink={c.red} disabled={busy} onPress={() => run({ decision: 'apply_update' }, 'The entry is no longer marked verified')} style={{ flex: 1 }} /> : null}
      </View>
      {sub === 'accept' ? <AcceptSheet source={source} rec={rec} onClose={() => setSub(null)} onDone={async () => { setSub(null); await onChanged(); }} /> : null}
      {sub === 'reject' ? (
        <FormSheet visible onClose={() => setSub(null)} title="Why is it rejected?" submitLabel="Reject" fields={[{ key: 'note', label: 'Reason (kept in the history)', multiline: true }]}
          onSubmit={async (v) => { try { await api.post(`/history-records/${rec.id}/review`, { decision: 'reject', row_version: rec.row_version, note: v.note }); setSub(null); await onChanged(); return 'Rejected. The record is kept.'; } catch (e) { throw new Error(say(e)); } }} />
      ) : null}
    </Card>
  );
}

function Queue({ source, onChanged }) {
  const [status, setStatus] = useState('attention');
  const q = useLoad(() => api.get(`/history-sources/${source.id}/records`, { status, limit: 50 }), [source.id, status]);
  const reload = async () => { await q.reload(); await onChanged(); };
  return (
    <View style={{ gap: 10 }}>
      <Seg options={[{ value: 'attention', label: 'To review' }, { value: 'accepted', label: 'Confirmed' }, { value: 'rejected', label: 'Rejected' }]} value={status} onChange={setStatus} />
      {q.loading && !q.data ? <Loading /> : q.error ? <ErrorBox error={q.error} onRetry={q.reload} /> : !q.data.length
        ? <Empty emoji="📭" title={status === 'attention' ? 'Nothing to review' : 'Nothing here yet'} sub={status === 'attention' ? 'Pull the feed or import a file to stage records.' : undefined} />
        : q.data.map((r) => <RecordCard key={r.id} source={source} rec={r} onChanged={reload} />)}
    </View>
  );
}

function Claims({ source, onChanged }) {
  const { toast } = useSession();
  const q = useLoad(() => api.get(`/history-sources/${source.id}/claims`, { limit: 50 }), [source.id]);
  const [deciding, setDeciding] = useState(null);
  const decide = async (x, decision, note) => { try { await api.post(`/history-identities/${x.id}/review`, { decision, note, row_version: x.row_version }); await q.reload(); await onChanged(); toast(decision === 'confirm' ? 'ID confirmed' : 'Claim rejected'); } catch (e) { toast(say(e)); } };
  if (q.loading && !q.data) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={q.reload} />;
  if (!q.data.length) return <Empty emoji="🪪" title="No ID claims waiting" sub="When a player says which ID your league knows them by, it appears here." />;
  return (
    <View style={{ gap: 10 }}>
      {q.data.map((x) => (
        <Card key={x.id} pad={14}>
          <T weight="800">{x.display_name}</T>
          <T size={13} color={c.mute}>Says their ID here is {x.external_ref} · {when(x.created_at)}</T>
          <T size={12} color={c.mute}>Confirm only if this ID is theirs in your register. Their records then match to them, and you still confirm each one.</T>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
            <Btn small title="This is their ID" onPress={() => decide(x, 'confirm')} style={{ flex: 1 }} />
            <Btn small title="Reject" color={c.paper} ink={c.red} onPress={() => setDeciding(x)} style={{ flex: 1 }} />
          </View>
        </Card>
      ))}
      {deciding ? <FormSheet visible onClose={() => setDeciding(null)} title="Why can’t you confirm it?" submitLabel="Reject" fields={[{ key: 'note', label: 'Reason the player will see', multiline: true }]}
        onSubmit={async (v) => { await decide(deciding, 'reject', v.note); setDeciding(null); return 'Rejected'; }} /> : null}
    </View>
  );
}

function Batches({ source }) {
  const q = useLoad(() => api.get(`/history-sources/${source.id}/batches`, { limit: 20 }), [source.id, source.last_sync_at]);
  if (q.loading && !q.data) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={q.reload} />;
  if (!q.data.length) return <Empty emoji="🗂️" title="Nothing received yet" />;
  return (
    <View style={{ gap: 8 }}>
      {q.data.map((b) => (
        <Card key={b.id} pad={12}>
          <T weight="700" size={13}>{b.mode === 'feed' ? 'Pulled from the feed' : 'Imported file'} · {when(b.created_at)}</T>
          <T size={12} color={c.mute}>{b.received} received · {b.created} new · {b.updated} changed · {b.unchanged} unchanged · {b.failed} skipped</T>
          {b.errors.slice(0, 5).map((e, i) => <T key={i} size={12} color={c.red}>{e.row ? `Row ${e.row}: ` : ''}{e.error}</T>)}
          {b.errors.length > 5 ? <T size={12} color={c.mute}>and {b.errors.length - 5} more</T> : null}
        </Card>
      ))}
    </View>
  );
}

function SourceSheet({ source, platform, onClose, onChanged }) {
  const { toast } = useSession();
  const [tab, setTab] = useState('review');
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [deciding, setDeciding] = useState(null);
  const [conn, connTone] = CONNECTION[source.connection];
  const approved = source.status === 'approved';
  const sync = async () => {
    setBusy(true);
    try { const r = await api.post(`/history-sources/${source.id}/sync`, {}); await onChanged(); toast(r.outcome === 'ok' ? `${r.created} new, ${r.updated} changed, ${r.unchanged} unchanged${r.failed ? `, ${r.failed} skipped` : ''}` : r.message ?? 'The feed could not be reached'); }
    catch (e) { toast(e?.details?.code === 'sync_in_progress' ? 'A sync is already running' : say(e)); } finally { setBusy(false); }
  };
  return (
    <Sheet visible onClose={onClose} title={source.name}>
      <View style={{ gap: 8 }}>
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
          <Tag label={STATUS[source.status][0]} color={STATUS[source.status][1]} />
          <Tag label={conn} color={connTone} />
          {source.sport ? <Tag label={source.sport} /> : <Tag label="Several sports" />}
        </View>
        {source.last_sync_error ? <T size={12} color={c.red}>{source.last_sync_error}</T> : null}
        {source.last_sync_at ? <T size={12} color={c.mute}>Last pull {when(source.last_sync_at)}</T> : null}
        {source.decision_note ? <T size={12} color={c.mute}>Platform team: “{source.decision_note}”</T> : null}
        {!approved ? <T size={13}>Nothing can be pulled, imported or confirmed until the platform team approves this source.</T> : null}
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          {source.adapter === 'api_json' ? <Btn small title="Pull the feed now" disabled={!approved || busy} loading={busy} onPress={sync} style={{ flex: 1 }} /> : null}
          <Btn small title={source.adapter === 'api_json' ? 'Import a file instead' : 'Import a file'} color={source.adapter === 'api_json' ? c.paper : c.violet} ink={source.adapter === 'api_json' ? c.ink : c.paper} disabled={!approved} onPress={() => setImporting(true)} style={{ flex: 1 }} />
        </View>
        {platform ? (
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {source.status !== 'approved' ? <Btn small title="Approve" onPress={() => api.post(`/history-sources/${source.id}/decision`, { decision: 'approve', row_version: source.row_version }).then(onChanged).then(() => toast('Approved')).catch((e) => toast(say(e)))} style={{ flex: 1 }} /> : null}
            {source.status !== 'suspended' ? <Btn small title="Suspend…" color={c.paper} ink={c.red} onPress={() => setDeciding(true)} style={{ flex: 1 }} /> : null}
          </View>
        ) : null}
        <Seg options={[{ value: 'review', label: `Review${source.needs_attention ? ` (${source.needs_attention})` : ''}` }, { value: 'claims', label: `IDs${source.claims_waiting ? ` (${source.claims_waiting})` : ''}` }, { value: 'batches', label: 'Imports' }]} value={tab} onChange={setTab} />
        <View style={{ marginTop: 6 }}>
          {tab === 'review' ? <Queue source={source} onChanged={onChanged} /> : tab === 'claims' ? <Claims source={source} onChanged={onChanged} /> : <Batches source={source} />}
        </View>
      </View>
      {importing ? <ImportFile source={source} onClose={() => setImporting(false)} onDone={async () => { setImporting(false); await onChanged(); }} /> : null}
      {deciding ? <FormSheet visible onClose={() => setDeciding(false)} title="Suspend this source" submitLabel="Suspend" fields={[{ key: 'note', label: 'Reason', multiline: true }]}
        onSubmit={async (v) => { try { await api.post(`/history-sources/${source.id}/decision`, { decision: 'suspend', note: v.note, row_version: source.row_version }); setDeciding(false); await onChanged(); return 'Suspended. Entries already confirmed stay, labelled with the source.'; } catch (e) { throw new Error(say(e)); } }} /> : null}
    </Sheet>
  );
}

/** Staff home for verified history: the sources you run, how each connects, and what is waiting for you. */
export function HistorySources() {
  const { user } = useSession();
  const list = useLoad(() => api.get('/history-sources', { limit: 100 }), []);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState(null);
  const platform = !!user?.roles?.includes('admin');
  const rows = list.data ?? [];
  const live = open ? rows.find((s) => s.id === open) : null;
  return (
    <Screen refreshing={list.loading && !!list.data} onRefresh={list.reload} wide>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <View style={{ flex: 1 }}>
          <H1>Verified history</H1>
          <T size={13} color={c.mute}>Leagues and federations that confirm a player’s clubs and seasons.</T>
        </View>
        <Btn small title="+ Source" onPress={() => setAdding(true)} accessibilityLabel="Register a league or federation" />
      </View>
      <T size={12} color={c.mute} style={{ marginTop: 8 }}>A live feed needs real API access from the league. Without it, upload their export: it is labelled as an uploaded file, never as live. Players’ own imported matches are not verification.</T>
      <View style={{ marginTop: 14, gap: 10 }}>
        {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !rows.length ? (
          <Empty emoji="🏟️" title="No sources yet" sub="Register a league or federation you run to start confirming players’ history." />
        ) : rows.map((s) => {
          const [conn, tone] = CONNECTION[s.connection];
          return (
            <Card key={s.id} pad={14} onPress={() => setOpen(s.id)} accessibilityLabel={`${s.name}, ${STATUS[s.status][0]}, ${conn}`}>
              <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
                <Tag label={STATUS[s.status][0]} color={STATUS[s.status][1]} /><Tag label={conn} color={tone} />
              </View>
              <T weight="800" size={17}>{s.name}</T>
              <T size={13} color={c.mute}>{nice(s.kind)} · {s.sport ?? 'several sports'}</T>
              <T size={13} style={{ marginTop: 6 }}>{s.needs_attention} to review · {s.claims_waiting} ID claim{s.claims_waiting === 1 ? '' : 's'} · {s.accepted} confirmed</T>
            </Card>
          );
        })}
      </View>
      {adding ? <RegisterSource canPlatform={platform} onClose={() => setAdding(false)} onDone={list.reload} /> : null}
      {live ? <SourceSheet source={live} platform={platform} onClose={() => setOpen(null)} onChanged={list.reload} /> : null}
    </Screen>
  );
}
