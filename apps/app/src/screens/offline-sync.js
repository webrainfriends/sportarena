import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useLayout } from '../layout';
import { useNav } from '../nav';
import { Btn, Card, Chip, Empty, ErrorBox, Loading, Screen, Section, Sheet, T, Tag } from '../ui';
import { c } from '../theme';
import { clearNotice, getSignOutMode, kindLabel, setSignOutMode, useOffline } from '../offline';

// Offline & sync (issue #336): the visible queue of drafts saved on this device, the conflicts that need a decision, and the devices
// that sync for the player. Everything here calls the API (sync_offline_batch, list_sync_operations, resolve_sync_conflict …).
const FIELD = { played_on: 'Date', opponent: 'Opponent', venue: 'Venue', competition: 'Competition', result: 'Result', score_for: 'Your score', score_against: 'Their score', minutes: 'Minutes played', rating: 'Rating', notes: 'Notes', match_type: 'Match type', stats: 'Your numbers' };
const show = (v) => (v === undefined || v === null || v === '' ? '—' : typeof v === 'object' ? Object.entries(v).map(([k, x]) => `${k.replace(/_/g, ' ')} ${x}`).join(', ') || '—' : String(v));
const time = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never');
const STATUS = { queued: ['Waiting', c.sun], syncing: ['Uploading', c.cyan], rejected: ['Not accepted', c.red] };

function Side({ title, text, tone }) {
  return (
    <View style={{ flex: 1, minWidth: 130, backgroundColor: tone ?? c.bg, borderRadius: 12, borderWidth: 1, borderColor: c.line, padding: 10, gap: 4 }}>
      <T size={11} weight="700" color={c.mute} style={{ letterSpacing: 0.8, textTransform: 'uppercase' }}>{title}</T>
      <T size={13}>{text}</T>
    </View>
  );
}

/** Compare the saved draft with the record as it is now, and let the player choose. */
function ConflictPanel({ op, onDone }) {
  const { toast } = useSession();
  const isMatch = op.kind === 'match_update';
  const fields = isMatch ? Object.keys(op.draft?.changes ?? {}) : ['status', 'athlete_rpe', 'athlete_feedback'].filter((k) => op.draft?.[k] !== undefined);
  const [take, setTake] = useState(() => new Set(fields));
  const [busy, setBusy] = useState(null);
  const draftVal = (k) => (isMatch ? op.draft.changes[k] : op.draft[k]);
  const label = (k) => FIELD[k] ?? { status: 'Outcome', athlete_rpe: 'Effort (1–10)', athlete_feedback: 'Your note' }[k] ?? k;
  const go = async (resolution) => {
    setBusy(resolution);
    try {
      await api.post(`/me/sync/operations/${op.id}/resolve`, { resolution, ...(resolution === 'merge' ? { fields: [...take] } : {}) });
      toast(resolution === 'keep_server' ? 'Kept the version on the server' : 'Your changes were applied');
      onDone();
    } catch (e) { toast(e.message); } finally { setBusy(null); }
  };
  return (
    <View style={{ gap: 10 }}>
      <T weight="800" size={16}>{kindLabel(op.kind)} changed on another device</T>
      <T size={13} color={c.mute}>Your draft was saved {time(op.captured_at ?? op.created_at)}. Pick what to keep. The version you do not keep is stored in the history, never deleted.</T>
      {!op.server ? <T size={13} color={c.red}>The record this draft was based on is no longer available. Keep the server version to close this.</T> : null}
      {fields.map((k) => (
        <View key={k} style={{ gap: 6 }}>
          <T size={12} weight="700">{label(k)}</T>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            <Side title="This draft" text={show(draftVal(k))} tone={take.has(k) ? c.pinkSoft : undefined} />
            <Side title="On the server" text={show(op.server?.[k])} tone={!take.has(k) ? c.pinkSoft : undefined} />
          </View>
          {isMatch ? <View style={{ flexDirection: 'row' }}><Chip label={take.has(k) ? `Using my ${label(k).toLowerCase()}` : `Using server ${label(k).toLowerCase()}`} active={take.has(k)}
            onPress={() => setTake((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; })} /></View> : null}
        </View>
      ))}
      <View style={{ gap: 8, marginTop: 4 }}>
        <Btn title="Keep my draft" loading={busy === 'keep_mine'} disabled={!!busy || !op.server} onPress={() => go('keep_mine')} />
        {isMatch ? <Btn title="Apply my field choices" color={c.paper} ink={c.ink} loading={busy === 'merge'} disabled={!!busy || !take.size || !op.server} onPress={() => go('merge')} /> : null}
        <Btn title="Keep server version" color={c.paper} ink={c.ink} loading={busy === 'keep_server'} disabled={!!busy} onPress={() => go('keep_server')} />
      </View>
    </View>
  );
}

function QueueItem({ it, retry, discard }) {
  const [sure, setSure] = useState(false);
  const [tag, tone] = STATUS[it.status] ?? STATUS.queued;
  return (
    <Card pad={12} accessibilityLabel={`${it.label}. ${tag}.`}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <T weight="700">{it.label}</T>
          <T size={12} color={c.mute}>{kindLabel(it.kind)}{it.sub ? ` · ${it.sub}` : ''} · saved {time(it.captured_at)}</T>
        </View>
        <Tag label={tag} color={tone} />
      </View>
      {it.status === 'rejected' ? <T size={12} color={c.red} style={{ marginTop: 6 }}>{it.message ?? 'The server did not accept this.'} It is still saved on this device.</T> : null}
      {it.status !== 'syncing' ? (
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          {it.status === 'rejected' && it.retryable !== false ? <Btn small title="Try again" onPress={() => retry(it.id)} /> : null}
          <Btn small title={sure ? 'Tap again to remove it' : 'Remove from this device'} color={c.paper} ink={c.red} accessibilityLabel={`Remove ${it.label} from this device`}
            onPress={() => (sure ? discard(it.id) : setSure(true))} />
        </View>
      ) : null}
    </Card>
  );
}

export function OfflineSync() {
  const o = useOffline();
  const { tablet } = useLayout();
  const { toast } = useSession();
  const ops = useLoad(() => api.get('/me/sync/operations', { limit: 100 }), [o.items.length, o.recent.length]);
  const [sel, setSel] = useState(null);
  const local = new Set(o.items.map((i) => i.client_key));
  const conflicts = (ops.data ?? []).filter((x) => x.status === 'conflict');
  const refused = (ops.data ?? []).filter((x) => x.status === 'rejected' && !local.has(x.client_key));
  const open = conflicts.find((x) => x.id === sel);
  const after = () => { setSel(null); ops.reload(); };

  const queue = (
    <>
      <Card color={o.online ? c.mintSoft : c.sunSoft} pad={14}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <View style={{ flex: 1 }}>
            <T weight="800">{o.online ? (o.syncing ? 'Uploading…' : o.waiting ? `${o.waiting} waiting to upload` : 'Everything is uploaded') : 'No connection'}</T>
            <T size={12} color={c.mute}>{o.online ? 'Drafts upload in the order you saved them and are removed from this device once the server has them.' : 'You can keep logging. Drafts stay encrypted on this device and upload when you are back online.'}</T>
          </View>
          <Btn small title="Sync now" loading={o.syncing} disabled={!o.waiting} onPress={() => o.flush()} />
        </View>
        {!o.persistent && o.ready ? <T size={12} color={c.red} style={{ marginTop: 8 }}>This browser cannot store drafts safely, so they are kept only while this page stays open. Use the app, or a browser with storage turned on, to log offline.</T> : null}
      </Card>
      {o.notice ? <Card color={c.redSoft} pad={12}><T size={13}>{o.notice}</T><Btn small title="Dismiss" color={c.paper} ink={c.ink} style={{ marginTop: 8, alignSelf: 'flex-start' }} onPress={clearNotice} /></Card> : null}

      <Section title="On this device" color={c.sun}>
        {!o.items.length ? <Empty emoji="📭" title="Nothing waiting" sub="Match logs, workout results and training loads you save without a connection appear here until they upload." /> : null}
        <View style={{ gap: 8 }}>{o.items.map((it) => <QueueItem key={it.id} it={it} retry={o.retry} discard={o.discard} />)}</View>
      </Section>

      {o.recent.length ? (
        <Section title="Just uploaded" color={c.mint}>
          <View style={{ gap: 8 }}>{o.recent.map((it) => (
            <Card key={`${it.id}`} pad={12}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
                <T weight="700" style={{ flex: 1 }}>{it.label}</T>
                <Tag label={it.outcome === 'conflict' ? 'Needs a decision' : 'Uploaded'} color={it.outcome === 'conflict' ? c.red : c.mint} />
              </View>
            </Card>))}</View>
        </Section>
      ) : null}

      <Section title="Needs a decision" color={c.red}>
        {ops.loading && !ops.data ? <Loading /> : null}
        {ops.error ? <ErrorBox error={ops.error} onRetry={ops.reload} /> : null}
        {!ops.loading && !ops.error && !conflicts.length ? <T size={13} color={c.mute}>No conflicts. If a record is changed on another device before your draft uploads, you choose here which version to keep.</T> : null}
        <View style={{ gap: 8 }}>{conflicts.map((x) => (
          <Card key={x.id} pad={12} onPress={() => setSel(x.id)} accessibilityLabel={`${kindLabel(x.kind)} changed on another device. Review.`}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
              <View style={{ flex: 1 }}><T weight="700">{kindLabel(x.kind)}</T><T size={12} color={c.mute}>Saved {time(x.captured_at ?? x.created_at)} · changed on another device</T></View>
              <Tag label="Review" color={c.red} />
            </View>
          </Card>))}</View>
      </Section>

      {refused.length ? (
        <Section title="Not accepted" color={c.red}>
          <View style={{ gap: 8 }}>{refused.map((x) => (
            <Card key={x.id} pad={12}>
              <T weight="700">{kindLabel(x.kind)}</T>
              <T size={12} color={c.mute}>{x.message}</T>
              <Btn small title="Remove saved copy" color={c.paper} ink={c.red} style={{ marginTop: 8, alignSelf: 'flex-start' }}
                onPress={async () => { try { await api.post(`/me/sync/operations/${x.id}/discard`); ops.reload(); } catch (e) { toast(e.message); } }} />
            </Card>))}</View>
        </Section>
      ) : null}
    </>
  );

  return (
    <Screen wide>
      {tablet ? (
        <View style={{ flexDirection: 'row', gap: 20, alignItems: 'flex-start' }}>
          <View style={{ flex: 1, minWidth: 0, gap: 12 }}>{queue}</View>
          <View style={{ flex: 1.1, minWidth: 0 }}>
            <Card>{open ? <ConflictPanel key={open.id} op={open} onDone={after} /> : <T size={13} color={c.mute}>Choose an item that needs a decision to compare the two versions here.</T>}</Card>
          </View>
        </View>
      ) : (
        <View style={{ gap: 12 }}>
          {queue}
          <Sheet visible={!!open} onClose={() => setSel(null)} title="Resolve conflict">{open ? <ConflictPanel key={open.id} op={open} onDone={after} /> : null}</Sheet>
        </View>
      )}
    </Screen>
  );
}

/** Devices that sync for the player, with remote sign-out, and what happens to drafts when signing out here. Used in Security. */
export function SyncDevices() {
  const { toast, signOut } = useSession();
  const list = useLoad(() => api.get('/me/sync/devices'), []);
  const [mode, setMode] = useState('sync');
  const [sure, setSure] = useState(null);
  useEffect(() => { getSignOutMode().then(setMode); }, []);
  const active = (list.data ?? []).filter((d) => !d.revoked_at);
  const gone = (list.data ?? []).filter((d) => d.revoked_at);
  const pick = (m) => { setMode(m); setSignOutMode(m); };
  const out = async (d) => {
    if (sure !== d.id) { setSure(d.id); return; }
    try {
      await api.del(`/me/sync/devices/${d.id}`);
      if (d.current) { await signOut(); return; }
      toast('That device was signed out and will remove its saved drafts'); setSure(null); list.reload();
    } catch (e) { toast(e.message); }
  };
  return (
    <Card style={{ marginTop: 12 }}>
      <T weight="800">Offline sync devices</T>
      <T size={12} color={c.mute}>Phones, tablets and browsers where you save drafts without a connection.</T>
      {list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : null}
      {list.loading && !list.data ? <Loading /> : null}
      {!list.loading && !list.error && !active.length ? <T size={12} color={c.mute} style={{ marginTop: 8 }}>No devices yet. This device is added the first time you save something offline.</T> : null}
      {active.map((d) => (
        <View key={d.id} style={{ paddingTop: 10, marginTop: 10, borderTopWidth: 1, borderColor: c.line, gap: 6 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <T weight="700">{d.label || d.platform} {d.current ? <Tag label="This device" color={c.mint} /> : null}</T>
              <T size={12} color={c.mute}>{d.platform} · last uploaded {time(d.last_sync_at)} · {d.queued} waiting</T>
            </View>
            <Btn small title={sure === d.id ? 'Tap again to confirm' : 'Sign out this device'} color={c.paper} ink={c.red} accessibilityLabel={`Sign out ${d.label || d.platform}`} onPress={() => out(d)} />
          </View>
        </View>
      ))}
      {gone.length ? <T size={12} color={c.mute} style={{ marginTop: 10 }}>Signed out: {gone.map((d) => d.label || d.platform).join(', ')}</T> : null}
      <View style={{ height: 1, backgroundColor: c.line, marginVertical: 12 }} />
      <T weight="700" size={13}>When I sign out on this device</T>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
        <Chip label="Upload, then keep anything left" active={mode === 'sync'} onPress={() => pick('sync')} />
        <Chip label="Remove drafts without uploading" active={mode === 'wipe'} onPress={() => pick('wipe')} />
      </View>
      <T size={12} color={c.mute} style={{ marginTop: 6 }}>{mode === 'sync' ? 'Drafts that could not upload stay encrypted on this device, locked to your account, and are removed if someone else signs in.' : 'Anything not yet uploaded is lost. Choose this on a shared or borrowed device.'}</T>
    </Card>
  );
}

/** A small chip for the Player tab: visible whenever there is something waiting, offline, or a conflict to settle. */
export function SyncChip() {
  const o = useOffline();
  const { push } = useNav();
  if (!o.ready || (o.online && !o.waiting && !o.items.length)) return null;
  const text = !o.online ? `Offline${o.waiting ? ` · ${o.waiting} waiting` : ''}` : o.syncing ? 'Uploading…' : `${o.items.length} waiting to upload`;
  return (
    <View style={{ flexDirection: 'row', marginTop: 8 }}>
      <Btn small title={text} color={o.online ? c.cyan : c.sun} onPress={() => push('OfflineSync')} accessibilityLabel={`${text}. Open Offline and sync.`} />
    </View>
  );
}
