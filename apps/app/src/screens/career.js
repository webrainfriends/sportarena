import React, { useRef, useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useLayout } from '../layout';
import { Btn, Card, Chip, Empty, ErrorBox, H1, H2, Loading, Screen, Sheet, T, Tag } from '../ui';
import { HScroll } from '../pickers';
import { FormSheet } from '../FormSheet';
import { MenuField } from '../menu-field';
import { useNav } from '../nav';
import { c } from '../theme';

const nice = (s) => String(s).replace(/_/g, ' ');
const cap = (s) => s.replace(/^./, (x) => x.toUpperCase());
const LEVELS = ['grassroots', 'school', 'club', 'academy', 'regional', 'national', 'international', 'professional'].map((value) => ({ value, label: nice(value).replace(/^./, (x) => x.toUpperCase()) }));
const EVIDENCE = [['club_letter', 'Club letter'], ['registration_card', 'Registration card'], ['roster_listing', 'Roster listing'], ['competition_record', 'Competition record'], ['other', 'Other']].map(([value, label]) => ({ value, label }));
const STATUS = {
  verified: ['Verified by club', c.mint], pending: ['Waiting for the club', c.sun], rejected: ['Not verified', c.red], unverified: ['Self-reported', c.violetSoft],
};
/** Who vouched for an entry, in plain words. Entries confirmed by an outside source say which, and whether it came by live feed or an uploaded file. */
const VIA = { external_feed: 'live feed', external_file: 'uploaded file' };
const statusOf = (m) => (m.verification_status === 'verified' && m.external
  ? [`Confirmed by ${m.external_source ?? 'a league'}`, c.mint]
  : STATUS[m.verification_status]);
const month = (s) => (s ? new Date(`${s}T12:00:00`).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }) : '');
const span = (m) => `${month(m.starts_on)} – ${m.current ? 'Present' : month(m.ends_on)}`;
const newKey = () => `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const seasons = () => { const y = new Date().getFullYear(); return Array.from({ length: 14 }, (_, i) => { const s = y + 1 - i; return `${s - 1}/${String(s).slice(2)}`; }).map((value) => ({ value, label: value })); };
/** A stale-version answer from the server is shown as an instruction, not an error code. */
const say = (e) => (e?.details?.code === 'stale_version' ? 'This entry was changed somewhere else. Pull to reload, then try again.' : e?.message ?? 'Something went wrong');

/** Add / correct a membership period. The club is picked from the platform; typing a name is only for clubs that are not listed. */
function EntryForm({ entry, forUser, sport, onClose, onDone }) {
  const key = useRef(newKey());
  const editing = !!entry;
  return (
    <FormSheet visible onClose={onClose} title={editing ? `Correct ${entry.club}` : 'Add a club or team'} submitLabel={editing ? 'Save correction' : 'Add to timeline'}
      initial={editing
        ? { starts_on: entry.starts_on, ends_on: entry.ends_on ?? undefined, still_here: entry.current, season_label: entry.season_label ?? undefined, position: entry.position ?? '', competition_level: entry.competition_level, jersey_no: entry.jersey_no ?? '', reason: '' }
        : { listed: 'listed', still_here: true, competition_level: 'club', sport: sport ?? undefined }}
      fields={[
        ...(editing ? [{ key: 'club_note', type: 'section', label: `${entry.sport_emoji} ${entry.club}${entry.unlisted ? ' (not listed)' : ''}` }] : [
          { key: 'listed', label: 'Which club?', type: 'chips', options: [{ value: 'listed', label: 'Pick from Gotmygame' }, { value: 'unlisted', label: 'Not listed' }] },
          { key: 'team_id', label: 'Club or team', type: 'entity', entityKind: 'team', noun: 'club or team', show: (v) => v.listed === 'listed' },
          { key: 'sport', label: 'Sport', type: 'sport', show: (v) => v.listed === 'unlisted' },
          { key: 'club_name', label: 'Club name', placeholder: 'As it appears on your registration', show: (v) => v.listed === 'unlisted', hint: 'Unlisted clubs stay self-reported unless the platform team confirms them.' },
        ]),
        { key: 'starts_on', label: 'Joined', type: 'date', max: new Date().toISOString().slice(0, 10) },
        { key: 'still_here', label: 'I am still here', type: 'switch' },
        { key: 'ends_on', label: 'Left', type: 'date', show: (v) => !v.still_here },
        { key: 'season_label', label: 'Season', type: 'chips', optional: true, options: seasons() },
        { key: 'competition_level', label: 'Competition level', type: 'chips', options: LEVELS },
        { key: 'position', label: 'Position', optional: true, placeholder: 'Striker, Opening bat…' },
        { key: 'jersey_no', label: 'Jersey number', optional: true, type: 'number' },
        ...(editing ? [{ key: 'reason', label: 'What are you correcting?', optional: true, hint: 'Kept in the history next to the old values.' }] : []),
      ]}
      onSubmit={async (v) => {
        try {
          const { listed, still_here, reason, ...rest } = v;
          const body = { ...rest, ...(forUser && !editing ? { user_id: forUser } : {}) };
          if (still_here) delete body.ends_on;
          if (editing) {
            await api.patch(`/me/career/${entry.id}`, { ...body, row_version: entry.row_version, reason: reason || undefined, clear_ends_on: still_here && !entry.current ? true : undefined });
          } else {
            await api.post('/me/career', { ...body, idempotency_key: key.current });
          }
          await onDone();
          return editing ? 'Correction saved' : 'Added to your timeline';
        } catch (e) { throw new Error(say(e)); }
      }} />
  );
}

function History({ entry, onClose }) {
  const rev = useLoad(() => api.get(`/me/career/${entry.id}/revisions`), [entry.id, entry.row_version]);
  const LABEL = { created: 'Added', corrected: 'Corrected', ended: 'Ended', verification_requested: 'Verification requested', verified: 'Verified by the club', rejected: 'Not verified', archived: 'Hidden', restored: 'Restored', roster_opened: 'Joined the roster', roster_closed: 'Left the roster', backfilled: 'Imported from your profile', external_linked: 'Confirmed by a league', external_merged: 'Merged with a league record', external_updated: 'Updated from a league record', external_disputed: 'Disputed by you', external_withdrawn: 'Withdrawn by the league' };
  return (
    <Sheet visible onClose={onClose} title="History">
      {rev.loading && !rev.data ? <Loading /> : rev.error ? <ErrorBox error={rev.error} onRetry={rev.reload} /> : (
        <View accessibilityRole="list" style={{ gap: 12 }}>
          {rev.data.map((r) => (
            <View key={r.id} style={{ flexDirection: 'row', gap: 10 }}>
              <View style={{ width: 10, height: 10, borderRadius: 5, marginTop: 5, backgroundColor: c.violet }} />
              <View style={{ flex: 1 }}>
                <T weight="800" size={14}>{LABEL[r.action] ?? r.action}</T>
                <T size={12} color={c.mute}>{new Date(r.created_at).toLocaleString()}{r.actor ? ` · ${r.actor}` : ''}</T>
                <T size={12} color={c.mute}>{[r.snapshot.position, r.snapshot.competition_level && nice(r.snapshot.competition_level), r.snapshot.starts_on && `from ${r.snapshot.starts_on}`, r.snapshot.ends_on && `to ${r.snapshot.ends_on}`].filter(Boolean).join(' · ')}</T>
                {r.reason ? <T size={13} style={{ marginTop: 2 }}>“{r.reason}”</T> : null}
              </View>
            </View>
          ))}
        </View>
      )}
    </Sheet>
  );
}

function Detail({ entry, forUser, onClose, onChanged, canEdit = true }) {
  const { toast } = useSession();
  const ev = useLoad(() => api.get(`/me/career/${entry.id}/evidence`), [entry.id, entry.evidence_count]);
  const [sub, setSub] = useState(null);
  const [busy, setBusy] = useState(false);
  const [label, tone] = statusOf(entry);
  const ext = useLoad(() => (entry.external ? api.get('/me/external-history', { user_id: forUser, limit: 100 }) : Promise.resolve([])), [entry.id, entry.row_version]);
  const extRec = (ext.data ?? []).find((r) => r.membership_id === entry.id);
  const run = async (fn, msg) => { setBusy(true); try { await fn(); await onChanged(); if (msg) toast(msg); } catch (e) { toast(say(e)); } finally { setBusy(false); } };
  const needsEvidence = (ev.data?.length ?? entry.evidence_count) === 0;
  return (
    <Sheet visible onClose={onClose} title={entry.club}>
      <View style={{ gap: 10 }}>
        <Tag label={label} color={tone} />
        <T size={14}>{entry.sport_emoji} {entry.sport} · {span(entry)}{entry.season_label ? ` · ${entry.season_label}` : ''}</T>
        <T size={14} color={c.mute}>{[entry.position, cap(nice(entry.competition_level)), entry.jersey_no !== null ? `#${entry.jersey_no}` : null, entry.source === 'roster' ? 'from the team roster' : entry.source === 'backfill' ? 'from your profile' : null].filter(Boolean).join(' · ')}</T>
        {entry.unlisted && !entry.external ? <T size={12} color={c.mute}>This club is not on Gotmygame, so it can only be confirmed by the platform team.</T> : null}
        {entry.external ? (
          <View style={{ gap: 6 }}>
            <T size={13}>{entry.verification_status === 'verified' ? `Confirmed by ${entry.external_source}` : `Came from ${entry.external_source}, no longer confirmed`}{entry.verified_via ? ` · ${VIA[entry.verified_via] ?? ''}` : ''}</T>
            {entry.verified_via === 'external_file' ? <T size={12} color={c.mute}>This came from an export file the league’s staff uploaded, not from a live connection.</T> : null}
            {extRec && ['accepted', 'changed'].includes(extRec.status) && canEdit ? <Btn small title="This is not mine or it is wrong" color={c.paper} ink={c.red} disabled={busy} onPress={() => setSub('dispute')} accessibilityLabel="Dispute this confirmed entry" /> : null}
            {extRec?.status === 'changed' ? <T size={12} color={c.mute}>{entry.external_source} sent a correction. Their staff will review it before your timeline changes.</T> : null}
          </View>
        ) : null}
        {entry.review_note ? <T size={13}>Club note: “{entry.review_note}”</T> : null}

        <H2 style={{ marginTop: 8 }}>Evidence</H2>
        {ev.loading && !ev.data ? <Loading /> : ev.error ? <ErrorBox error={ev.error} onRetry={ev.reload} /> : !ev.data.length
          ? <T size={13} color={c.mute}>No evidence yet. Add a club letter, registration card or roster listing so the club can confirm this.</T>
          : ev.data.map((e) => <View key={e.id}><T weight="700" size={13}>{EVIDENCE.find((k) => k.value === e.kind)?.label}{e.label ? ` · ${e.label}` : ''}</T><T size={12} color={c.mute}>{e.reference}</T></View>)}

        {canEdit && !entry.archived_at ? (
          <View style={{ gap: 8, marginTop: 8 }}>
            <Btn small title="+ Add evidence" color={c.paper} onPress={() => setSub('evidence')} />
            {['unverified', 'rejected'].includes(entry.verification_status) ? (
              <Btn small title={entry.unlisted ? 'Ask the platform team to verify' : 'Ask the club to verify'} disabled={busy || needsEvidence} loading={busy}
                onPress={() => run(() => api.post(`/me/career/${entry.id}/request-verification`, { row_version: entry.row_version }), 'Request sent')} />
            ) : null}
            {needsEvidence && ['unverified', 'rejected'].includes(entry.verification_status) ? <T size={12} color={c.mute}>Add evidence first to request verification.</T> : null}
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Btn small title="Correct" color={c.paper} onPress={() => setSub('edit')} style={{ flex: 1 }} />
              <Btn small title="History" color={c.paper} onPress={() => setSub('history')} style={{ flex: 1 }} />
              <Btn small title="Hide" color={c.paper} ink={c.red} disabled={busy} onPress={() => run(() => api.post(`/me/career/${entry.id}/archive`, { row_version: entry.row_version }), 'Hidden. It is kept and can be restored.').then(onClose)} style={{ flex: 1 }} />
            </View>
          </View>
        ) : canEdit ? (
          <Btn small title="Restore" disabled={busy} onPress={() => run(() => api.post(`/me/career/${entry.id}/archive`, { row_version: entry.row_version, archived: false }), 'Restored').then(onClose)} />
        ) : null}
      </View>
      {sub === 'dispute' && extRec ? (
        <FormSheet visible onClose={() => setSub(null)} title="Dispute this entry" submitLabel="Send to the league"
          fields={[{ key: 'reason', label: 'What is wrong?', multiline: true, hint: 'The entry is hidden and no longer marked confirmed. It is kept, and the league’s staff are told.' }]}
          onSubmit={async (v) => { try { await api.post(`/me/external-history/${extRec.id}/dispute`, { reason: v.reason, row_version: extRec.row_version }); await onChanged(); onClose(); return 'Sent. The entry is hidden for now.'; } catch (e) { throw new Error(say(e)); } }} />
      ) : null}
      {sub === 'history' ? <History entry={entry} onClose={() => setSub(null)} /> : null}
      {sub === 'edit' ? <EntryForm entry={entry} forUser={forUser} onClose={() => setSub(null)} onDone={async () => { await onChanged(); onClose(); }} /> : null}
      {sub === 'evidence' ? (
        <FormSheet visible onClose={() => setSub(null)} title="Add evidence" submitLabel="Attach"
          fields={[
            { key: 'kind', label: 'What is it?', type: 'chips', options: EVIDENCE },
            { key: 'reference', label: 'Reference', placeholder: 'Letter number, registration id or link', hint: 'Stored encrypted. Only you, your guardian and the club\'s staff can read it.' },
            { key: 'label', label: 'Note', optional: true },
          ]}
          initial={{ kind: 'club_letter' }}
          onSubmit={async (v) => { try { await api.post(`/me/career/${entry.id}/evidence`, v); await ev.reload(); await onChanged(); return 'Evidence attached'; } catch (e) { throw new Error(say(e)); } }} />
      ) : null}
    </Sheet>
  );
}

/** Staff of a club/team see requests to confirm a membership; they can verify or reject with a note. */
function ReviewQueue({ onChanged }) {
  const q = useLoad(() => api.get('/career/review-queue'), []);
  const { toast } = useSession();
  const [open, setOpen] = useState(null);
  if (!q.data?.length) return null;
  return (
    <View style={{ marginTop: 26 }}>
      <H2>Membership requests for your clubs</H2>
      <T size={12} color={c.mute} style={{ marginTop: 4 }}>Only confirm what you can vouch for. The player sees your note.</T>
      <View style={{ gap: 10, marginTop: 10 }}>
        {q.data.map((m) => (
          <Card key={m.id} pad={14}>
            <T weight="700">{m.club}</T>
            <T size={12} color={c.mute}>{span(m)} · {m.sport}{m.position ? ` · ${m.position}` : ''}</T>
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
              <Btn small title="See evidence & decide" onPress={() => setOpen(m)} style={{ flex: 1 }} />
            </View>
          </Card>
        ))}
      </View>
      {open ? <Review m={open} onClose={() => setOpen(null)} onDone={async () => { setOpen(null); await q.reload(); await onChanged?.(); toast('Decision recorded'); }} /> : null}
    </View>
  );
}

function Review({ m, onClose, onDone }) {
  const ev = useLoad(() => api.get(`/me/career/${m.id}/evidence`), [m.id]);
  const [mode, setMode] = useState(null);
  return (
    <Sheet visible onClose={onClose} title={`Review: ${m.club}`}>
      <T size={13} color={c.mute}>{span(m)} · {nice(m.competition_level)}{m.position ? ` · ${m.position}` : ''}</T>
      <H2 style={{ marginTop: 12 }}>Evidence</H2>
      {ev.loading && !ev.data ? <Loading /> : ev.error ? <ErrorBox error={ev.error} onRetry={ev.reload} /> : ev.data.map((e) => <View key={e.id} style={{ marginTop: 6 }}><T weight="700" size={13}>{EVIDENCE.find((k) => k.value === e.kind)?.label}</T><T size={12} color={c.mute}>{e.reference}</T></View>)}
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 16 }}>
        <Btn title="Verify" onPress={() => setMode('verify')} style={{ flex: 1 }} />
        <Btn title="Reject" color={c.paper} ink={c.red} onPress={() => setMode('reject')} style={{ flex: 1 }} />
      </View>
      {mode ? (
        <FormSheet visible onClose={() => setMode(null)} title={mode === 'verify' ? 'Verify membership' : 'Why can\'t you verify it?'} submitLabel={mode === 'verify' ? 'Verify' : 'Reject'}
          fields={[{ key: 'note', label: mode === 'verify' ? 'Note (optional)' : 'Reason the player will see', optional: mode === 'verify', multiline: true }]}
          onSubmit={async (v) => { try { await api.post(`/career/${m.id}/review`, { decision: mode, note: v.note || undefined, row_version: m.row_version }); await onDone(); } catch (e) { throw new Error(say(e)); } }} />
      ) : null}
    </Sheet>
  );
}

/** League and federation IDs: say which ID a league knows you by; its staff confirm it before any of its records reach your timeline. */
function OfficialIds({ forUser, onChanged }) {
  const { toast } = useSession();
  const { push } = useNav();
  const ids = useLoad(() => api.get('/me/history-identities', { user_id: forUser }), [forUser]);
  const sources = useLoad(() => api.get('/history-sources/approved', { limit: 100 }), []);
  const mine = useLoad(() => api.get('/history-sources', { limit: 1 }).catch(() => []), []);
  const [adding, setAdding] = useState(false);
  const label = { claimed: ['Waiting for the league', c.sun], confirmed: ['Confirmed by the league', c.mint] };
  return (
    <View style={{ marginTop: 26 }}>
      <H2>Leagues and federations</H2>
      <T size={12} color={c.mute} style={{ marginTop: 4 }}>Link the ID a league or federation knows you by. Once its staff confirm it, they can confirm your clubs and seasons here. You can dispute anything they add.</T>
      <View style={{ gap: 10, marginTop: 10 }}>
        {ids.loading && !ids.data ? <Loading /> : ids.error ? <ErrorBox error={ids.error} onRetry={ids.reload} /> : !ids.data.length ? (
          <T size={13} color={c.mute}>{sources.data?.length ? 'No ID linked yet.' : 'No league or federation has been connected to Gotmygame yet.'}</T>
        ) : ids.data.map((x) => (
          <Card key={x.id} pad={14}>
            <View style={{ flexDirection: 'row', gap: 6, marginBottom: 6 }}><Tag label={label[x.status][0]} color={label[x.status][1]} /></View>
            <T weight="700">{x.source}</T>
            <T size={13} color={c.mute}>Your ID there: {x.external_ref}</T>
            <Btn small title="Remove link" color={c.paper} ink={c.red} style={{ marginTop: 8 }} accessibilityLabel={`Remove the link to ${x.source}`}
              onPress={async () => { try { await api.post(`/me/history-identities/${x.id}/revoke`, { row_version: x.row_version }); await ids.reload(); await onChanged(); toast('Link removed. Anything it confirmed is hidden and kept.'); } catch (e) { toast(say(e)); } }} />
          </Card>
        ))}
      </View>
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        {sources.data?.length ? <Btn small title="+ Link my ID" onPress={() => setAdding(true)} accessibilityLabel="Link my ID at a league or federation" /> : null}
        {mine.data?.length ? <Btn small title="Manage verified sources" color={c.paper} onPress={() => push('HistorySources')} /> : null}
      </View>
      {adding ? (
        <FormSheet visible onClose={() => setAdding(false)} title="Link my ID" submitLabel="Send to the league"
          fields={[
            { key: 'source_id', type: 'custom', render: ({ v, set }) => <MenuField label="League or federation" value={v.source_id} onChange={(x) => set('source_id', x)} options={(sources.data ?? []).map((s) => ({ value: s.id, label: s.name, sub: [s.sport, s.connection === 'live' ? 'live feed' : s.connection === 'file_only' ? 'uploaded files' : null].filter(Boolean).join(' · ') }))} /> },
            { key: 'external_ref', label: 'Your ID there', placeholder: 'Player or registration number', hint: 'Stored encrypted. The league’s staff check it against their register.' },
          ]}
          onSubmit={async (v) => { try { if (!v.source_id) throw new Error('Choose a league or federation'); await api.post('/me/history-identities', { source_id: v.source_id, external_ref: v.external_ref, user_id: forUser }); await ids.reload(); return 'Sent. You will be told when they confirm it.'; } catch (e) { throw new Error(say(e)); } }} />
      ) : null}
    </View>
  );
}

/**
 * Career & membership timeline: every club/team the player has been with, current and former, with season, position, level and
 * how far each entry is verified. `sport` filters to one sport; `user_id` lets a verified guardian manage a young person's timeline.
 */
export function CareerTimeline({ sport, user_id: forUser }) {
  const { phone } = useLayout();
  const { toast } = useSession();
  const [filter, setFilter] = useState(sport ?? 'all');
  const [hidden, setHidden] = useState(false);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState(null);
  const list = useLoad(() => api.get('/me/career', { include_archived: hidden, user_id: forUser, limit: 100 }), [hidden, forUser]);
  const rows = list.data ?? [];
  const sports = [...new Map(rows.map((m) => [m.sport_slug, m])).values()];
  const shown = rows.filter((m) => filter === 'all' || m.sport_slug === filter);
  const live = open ? rows.find((m) => m.id === open.id) ?? open : null;
  const exportCsv = async () => {
    try { const r = await api.get('/me/career/export', { user_id: forUser }); if (typeof document !== 'undefined') { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([r.csv], { type: 'text/csv' })); a.download = r.filename; a.click(); } else toast(`${r.rows} entries exported`); } catch (e) { toast(say(e)); }
  };

  return (
    <Screen refreshing={list.loading && !!list.data} onRefresh={list.reload} wide>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <View style={{ flex: 1 }}>
          <H1>Career</H1>
          <T size={13} color={c.mute}>Every club and team you have played for.</T>
        </View>
        <Btn small title="+ Add" onPress={() => setAdding(true)} accessibilityLabel="Add a club or team" />
      </View>

      {sports.length > 1 ? (
        <HScroll style={{ marginTop: 12 }}>
          <Chip label="All sports" active={filter === 'all'} onPress={() => setFilter('all')} />
          {sports.map((s) => <Chip key={s.sport_slug} label={`${s.sport_emoji} ${s.sport}`} active={filter === s.sport_slug} onPress={() => setFilter(s.sport_slug)} />)}
        </HScroll>
      ) : null}

      <View style={{ marginTop: 14 }}>
        {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !shown.length ? (
          <Empty emoji="🧭" title="No clubs on your timeline yet" sub="Add the clubs and teams you have played for. Joining a team on Gotmygame adds it automatically." />
        ) : (
          <View accessibilityRole="list" accessibilityLabel="Career timeline" style={phone ? { gap: 0 } : { gap: 0, maxWidth: 720 }}>
            {shown.map((m, i) => {
              const [text, tone] = statusOf(m);
              return (
                <View key={m.id} style={{ flexDirection: 'row', gap: 12 }}>
                  <View style={{ alignItems: 'center', width: 16 }}>
                    <View style={{ width: 12, height: 12, borderRadius: 6, marginTop: 18, backgroundColor: m.current ? c.pink : c.violet, opacity: m.archived_at ? 0.35 : 1 }} />
                    {i < shown.length - 1 ? <View style={{ flex: 1, width: 2, backgroundColor: c.line }} /> : null}
                  </View>
                  <Card onPress={() => setOpen(m)} pad={14} style={{ flex: 1, marginVertical: 6, opacity: m.archived_at ? 0.6 : 1 }} accessibilityLabel={`${m.club}, ${span(m)}, ${text}`}>
                    <T size={12} weight="700" color={c.pink}>{span(m)}{m.current ? '' : ' · former'}</T>
                    <T weight="800" size={17} style={{ marginTop: 2 }}>{m.club}</T>
                    <T size={13} color={c.mute}>{[m.sport_emoji + ' ' + m.sport, m.position, cap(nice(m.competition_level)), m.season_label, m.jersey_no !== null ? `#${m.jersey_no}` : null].filter(Boolean).join(' · ')}</T>
                    <View style={{ flexDirection: 'row', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                      <Tag label={text} color={tone} />
                      {m.external && m.verified_via ? <Tag label={m.verified_via === 'external_feed' ? 'Live feed' : 'Uploaded file'} /> : null}
                      {m.unlisted && !m.external ? <Tag label="Not listed" /> : null}
                      {m.evidence_count ? <Tag label={`${m.evidence_count} evidence`} /> : null}
                      {m.corrections ? <Tag label={`${m.corrections} correction${m.corrections === 1 ? '' : 's'}`} /> : null}
                      {m.archived_at ? <Tag label="Hidden" /> : null}
                    </View>
                  </Card>
                </View>
              );
            })}
          </View>
        )}
      </View>

      <View style={{ flexDirection: 'row', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
        <Btn small title={hidden ? 'Hide archived' : 'Show hidden entries'} color={c.paper} onPress={() => setHidden(!hidden)} />
        <Btn small title="Export CSV" color={c.paper} onPress={exportCsv} />
      </View>
      <T size={12} color={c.mute} style={{ marginTop: 10 }}>Clubs can verify entries you have evidence for. Verified entries are labelled; everything else is shown as self-reported. Entries are hidden, never deleted, and every correction is kept.</T>

      {!forUser ? <ReviewQueue onChanged={list.reload} /> : null}
      <OfficialIds forUser={forUser} onChanged={list.reload} />

      {adding ? <EntryForm forUser={forUser} sport={sport} onClose={() => setAdding(false)} onDone={list.reload} /> : null}
      {live ? <Detail entry={live} forUser={forUser} onClose={() => setOpen(null)} onChanged={list.reload} /> : null}
    </Screen>
  );
}
