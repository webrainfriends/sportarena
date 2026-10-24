import React, { useRef, useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, ErrorBox, Field, H1, H2, Loading, Screen, Seg, Sheet, T, Tag } from '../ui';
import { HScroll } from '../pickers';
import { FormSheet } from '../FormSheet';
import { c } from '../theme';

const nice = (s) => String(s ?? '').replace(/_/g, ' ');
const cap1 = (s) => nice(s).replace(/^./, (x) => x.toUpperCase());
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');
const newKey = () => `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const inDays = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const say = (e) => (e?.details?.code === 'stale_version' ? 'This was changed somewhere else. Pull to reload, then try again.' : e?.message ?? 'Something went wrong');

const SCOPES = [
  ['profile', 'Playing profile', 'Level, position, club, region, how they play'],
  ['measurements', 'Measurements', 'Only the measurements they chose to share'],
  ['career', 'Career timeline', 'Clubs and seasons, with verification labels'],
  ['contact', 'Contact details', 'Email and phone (adults only)'],
  ['messages', 'Messages', 'Chat in the app while access lasts'],
];
const SCOPE_NAME = Object.fromEntries(SCOPES.map(([k, l]) => [k, l]));
const PURPOSES = ['scouting', 'trial', 'scholarship', 'signing'].map((value) => ({ value, label: cap1(value) }));
const STAGES = ['prospect', 'shortlist', 'contacted', 'trial', 'offer', 'passed'];
const BASES = [['live_viewing', 'Live viewing'], ['video', 'Video'], ['match_report', 'Match report'], ['trial', 'Trial'], ['profile_only', 'Profile only']].map(([value, label]) => ({ value, label }));
const CRITERIA = ['technical', 'tactical', 'physical', 'mental', 'potential'];
const NOT_LIVE = {
  requested: 'Waiting for the athlete', declined: 'Declined', withdrawn: 'Withdrawn', revoked: 'Access ended', expired: 'Expired',
  recruiter_unverified: 'Your verification lapsed', guardian_consent_withdrawn: 'Guardian withdrew consent', no_scope: 'Nothing allowed', access_ended: 'Access ended',
};
const STATUS_TONE = { approved: c.lime, requested: c.sunSoft, declined: c.pinkSoft, withdrawn: c.violetSoft, revoked: c.pinkSoft, expired: c.violetSoft };
const SOURCE = { self: 'self-reported', coach: 'recorded by a coach', test: 'from a test' };
const VERIFY = { verified: 'verified by club', pending: 'awaiting club', unverified: 'self-reported', rejected: 'not verified' };

const AccessTag = ({ r }) => <Tag label={r.live ? `Live until ${day(r.expires_at)}` : NOT_LIVE[r.not_live_reason ?? r.status] ?? cap1(r.status)} color={r.live ? c.lime : STATUS_TONE[r.status]} />;
const download = (r) => { if (typeof document !== 'undefined') { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([r.csv], { type: 'text/csv' })); a.download = r.filename; a.click(); } };

// ------------------------------------------------------------------ messages (both sides)
export function Thread({ request, onClose, title }) {
  const { toast } = useSession();
  const t = useLoad(() => api.get(`/recruiter/requests/${request.id}/messages`), [request.id]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const key = useRef(newKey());
  const send = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try { await api.post(`/recruiter/requests/${request.id}/messages`, { body: text.trim(), idempotency_key: key.current }); setText(''); key.current = newKey(); t.reload(); } catch (e) { toast(say(e)); } finally { setBusy(false); }
  };
  return (
    <Sheet visible onClose={onClose} title={title ?? 'Messages'}>
      {t.loading && !t.data ? <Loading /> : t.error ? <ErrorBox error={t.error} onRetry={t.reload} /> : (
        <>
          {!t.data.messages.length ? <Empty emoji="💬" title="No messages yet" sub={t.data.can_send ? 'Write the first message below.' : 'Messaging is not available on this request.'} /> : (
            <View style={{ gap: 8 }} accessibilityRole="list">
              {t.data.messages.map((m) => (
                <View key={m.id} style={{ alignSelf: m.mine ? 'flex-end' : 'flex-start', maxWidth: '86%' }}>
                  <View style={{ backgroundColor: m.mine ? c.violetSoft : c.paper, borderRadius: 16, padding: 12, borderWidth: 1, borderColor: c.line }}>
                    <T size={12} weight="800" color={c.mute}>{m.sender}{m.sender_role === 'guardian' ? ' (guardian)' : ''}</T>
                    <T>{m.body}</T>
                  </View>
                  <T size={11} color={c.mute} style={{ alignSelf: m.mine ? 'flex-end' : 'flex-start' }}>{new Date(m.created_at).toLocaleString()}</T>
                </View>
              ))}
            </View>
          )}
          {t.data.closed ? <T size={13} color={c.mute}>This conversation was closed by the athlete.</T> : t.data.can_send ? (
            <View style={{ gap: 8 }}>
              <Field label="Message" value={text} onChangeText={setText} multiline maxLength={2000} placeholder="Write a message…" />
              <Btn title="Send" onPress={send} loading={busy} disabled={!text.trim()} />
            </View>
          ) : <T size={13} color={c.mute}>Messaging is not active, so you cannot send right now.</T>}
        </>
      )}
    </Sheet>
  );
}

// ------------------------------------------------------------------ recruiter: what the athlete allowed
function Dossier({ request, onClose }) {
  const { toast } = useSession();
  const d = useLoad(() => api.get(`/recruiter/requests/${request.id}/athlete`), [request.id]);
  const [contact, setContact] = useState(null);
  const reveal = async () => { try { setContact(await api.get(`/recruiter/requests/${request.id}/contact`)); } catch (e) { toast(say(e)); } };
  const p = d.data?.profile;
  return (
    <Sheet visible onClose={onClose} title={request.athlete_name ?? 'Athlete'}>
      {d.loading && !d.data ? <Loading /> : d.error ? (
        <Card color={c.pinkSoft}><T weight="800">Access is not active</T><T size={13}>The athlete has not allowed (or has ended) your access. Nothing is shown.</T></Card>
      ) : (
        <>
          <T size={12} color={c.mute}>Shown live under your grant for {d.data.purpose}, until {day(d.data.expires_at)}. Allowed: {d.data.scopes.map((s) => SCOPE_NAME[s]).join(', ')}.</T>
          {d.data.verified?.length ? <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{d.data.verified.map((b) => <Tag key={b.type} label={`✓ Verified ${b.type}`} color={c.lime} />)}</View> : null}
          {p ? (
            <Card pad={12}>
              <T weight="800">Playing profile</T>
              {[['Level', cap1(p.level)], ['Position', p.position], ['Club (self-reported)', p.club], ['Region', p.region], ['Experience', p.experience_years != null ? `${p.experience_years} years` : null], ['Jersey', p.jersey_no != null ? `#${p.jersey_no}` : null], ['Dominant side', p.dominant_side && cap1(p.dominant_side)], ['Positions', p.positions?.join(', ')], ['Plays', p.play_prefs?.join(', ')]]
                .filter(([, v]) => v).map(([k, v]) => <View key={k} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 }}><T size={13} color={c.mute}>{k}</T><T size={13} weight="700" style={{ flexShrink: 1, textAlign: 'right' }}>{v}</T></View>)}
            </Card>
          ) : d.data.scopes.includes('profile') ? <T size={13} color={c.mute}>No profile fields are shared for this sport.</T> : null}
          {d.data.measurements ? (
            <Card pad={12}>
              <T weight="800">Measurements</T>
              {!d.data.measurements.length ? <T size={13} color={c.mute}>The athlete has not shared any measurements.</T> : d.data.measurements.map((m, i) => (
                <View key={i} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 }}>
                  <T size={13}>{cap1(m.metric)}</T><T size={13} weight="700">{m.value} {m.unit} <T size={11} color={c.mute}>· {day(m.measured_on)} · {SOURCE[m.source]}</T></T>
                </View>
              ))}
            </Card>
          ) : null}
          {d.data.career ? (
            <Card pad={12}>
              <T weight="800">Career</T>
              {!d.data.career.length ? <T size={13} color={c.mute}>No career entries.</T> : d.data.career.map((m) => (
                <View key={m.id} style={{ paddingVertical: 4 }}>
                  <T size={13} weight="700">{m.club}{m.current ? ' (current)' : ''}</T>
                  <T size={12} color={c.mute}>{m.starts_on?.slice(0, 7)} – {m.current ? 'present' : m.ends_on?.slice(0, 7)} · {cap1(m.competition_level)} · {VERIFY[m.verification_status]}</T>
                </View>
              ))}
            </Card>
          ) : null}
          {d.data.scopes.includes('contact') ? (
            contact ? <Card pad={12}><T weight="800">Contact</T><T size={13}>{contact.email}</T>{contact.phone ? <T size={13}>{contact.phone}</T> : null}<T size={11} color={c.mute}>Viewing contact details is logged.</T></Card>
              : <Btn small title="Show contact details" color={c.paper} onPress={reveal} />
          ) : null}
        </>
      )}
    </Sheet>
  );
}

// ------------------------------------------------------------------ recruiter: ask an athlete for access
function RequestAccess({ onClose, onDone }) {
  const { toast } = useSession();
  const [handle, setHandle] = useState('');
  const [found, setFound] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const key = useRef(newKey());
  const find = async () => {
    setBusy(true); setErr(null); setFound(null);
    try { setFound(await api.get('/recruiter/athletes/lookup', { handle: handle.trim().toLowerCase().replace(/^@/, '') })); } catch (e) { setErr(e.status === 404 ? 'No athlete with that exact handle. Ask them for it — athletes cannot be browsed.' : say(e)); } finally { setBusy(false); }
  };
  if (found) {
    const youth = found.is_youth;
    const busySports = new Set((found.open_requests ?? []).map((r) => r.sport_id));
    const free = found.sports.filter((s) => !busySports.has(s.id));
    if (!free.length) {
      return (
        <Sheet visible onClose={onClose} title={found.display_name}>
          <Card color={c.sunSoft}><T weight="800">You already have an open request</T><T size={13}>Wait for the athlete to answer, or end it from Requests, before asking again.</T></Card>
          <Btn title="Back" color={c.paper} onPress={() => setFound(null)} />
        </Sheet>
      );
    }
    return (
      <FormSheet visible onClose={onClose} title={`Ask ${found.display_name} for access`} submitLabel="Send request"
        initial={{ sport: free[0]?.slug, scopes: ['profile', 'measurements', 'career'], purpose: 'scouting', expires_on: inDays(30), message: '' }}
        fields={[
          ...(youth ? [{ key: 'youth_note', type: 'section', label: 'This is a young person. A verified guardian decides, and direct contact details are never shared. Messages go through the guardian.' }] : []),
          { key: 'sport', label: 'Sport', type: 'chips', options: free.map((s) => ({ value: s.slug, label: `${s.emoji} ${s.name}` })) },
          { key: 'scopes', label: 'What do you need to see?', type: 'multi', options: SCOPES.filter(([k]) => !(youth && k === 'contact')).map(([value, label, hint]) => ({ value, label })) },
          { key: 'purpose', label: 'Why?', type: 'chips', options: PURPOSES },
          { key: 'expires_on', label: 'Access until', type: 'date', min: inDays(1), max: inDays(180), hint: 'Up to 180 days. The athlete can end it sooner at any time.' },
          { key: 'message', label: 'Message to the athlete', type: 'multiline', optional: true, hint: 'Say who you recruit for and what you have in mind.' },
        ]}
        onSubmit={async (v) => {
          try {
            await api.post('/recruiter/requests', { athlete_id: found.id, sport: v.sport, scopes: v.scopes, purpose: v.purpose, expires_on: v.expires_on, message: v.message || undefined, idempotency_key: key.current });
            toast('Request sent'); onDone(); onClose();
          } catch (e) { throw new Error(e.details?.code === 'duplicate_request' ? 'You already have an open request for this athlete and sport.' : say(e)); }
        }}
      />
    );
  }
  return (
    <Sheet visible onClose={onClose} title="Find an athlete">
      <T size={13} color={c.mute}>Athletes cannot be browsed or searched. Enter the exact handle the athlete, their club or their passport gave you.</T>
      <Field label="Athlete handle" value={handle} onChangeText={setHandle} placeholder="e.g. aarav_k" autoCapitalize="none" />
      {err ? <T size={13} color={c.red} accessibilityRole="alert">{err}</T> : null}
      <Btn title="Find athlete" onPress={find} loading={busy} disabled={handle.trim().length < 3} />
    </Sheet>
  );
}

// ------------------------------------------------------------------ recruiter: one saved athlete
function EntrySheet({ entry, onClose, onChanged, openThread, openDossier }) {
  const { toast } = useSession();
  const d = useLoad(() => api.get(`/recruiter/entries/${entry.id}`), [entry.id, entry.row_version]);
  const [form, setForm] = useState(null);
  const evKey = useRef(newKey());
  const ctKey = useRef(newKey());
  const e = d.data ?? entry;
  const live = !e.redacted;
  const reload = () => { d.reload(); onChanged(); };
  const move = async (stage) => { try { await api.patch(`/recruiter/entries/${e.id}`, { stage, row_version: e.row_version }); reload(); } catch (x) { toast(say(x)); reload(); } };
  const archive = async () => { try { await api.patch(`/recruiter/entries/${e.id}`, { archived: true, row_version: e.row_version }); onChanged(); onClose(); } catch (x) { toast(say(x)); } };
  const ev = form?.type === 'eval' ? form.item : null;
  return (
    <Sheet visible onClose={onClose} title={live ? e.athlete.display_name : 'Access ended'}>
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
        <Tag label={`${e.sport_emoji} ${e.sport}`} />
        <Tag label={live ? `Live until ${day(e.grant_expires_at)}` : NOT_LIVE[e.access] ?? 'Access ended'} color={live ? c.lime : c.pinkSoft} />
      </View>
      {!live ? <Card color={c.pinkSoft}><T size={13}>The athlete's details are no longer available to you. Your stage and scores stay; your notes are withheld.</T></Card> : null}
      <T weight="800">Stage</T>
      <HScroll>{STAGES.map((s) => <Chip key={s} label={cap1(s)} active={e.stage === s} onPress={() => (e.stage === s ? null : move(s))} />)}</HScroll>
      {live ? (
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          <Btn small title="View profile" color={c.paper} onPress={() => openDossier(e)} />
          {e.scopes?.includes('messages') ? <Btn small title="Message" color={c.paper} onPress={() => openThread(e)} /> : null}
          <Btn small title="Log contact" color={c.paper} onPress={() => setForm({ type: 'contact' })} />
          <Btn small title="+ Evaluation" onPress={() => setForm({ type: 'eval' })} />
        </View>
      ) : null}
      <H2>Evaluations</H2>
      {d.loading && !d.data ? <Loading /> : !d.data?.evaluations.length ? <Empty emoji="📝" title="No evaluations yet" sub={live ? 'Rate what you saw and say what it was based on.' : ''} /> : d.data.evaluations.map((x) => (
        <Card key={x.id} pad={12}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <T weight="800">{'★'.repeat(x.overall)}{'☆'.repeat(5 - x.overall)}</T>
            <T size={12} color={c.mute}>{day(x.observed_on)} · {cap1(x.basis)}</T>
          </View>
          <T size={12} color={c.mute}>{CRITERIA.filter((k) => x.ratings[k]).map((k) => `${cap1(k)} ${x.ratings[k]}`).join(' · ')}</T>
          {x.notes ? <T size={13}>{x.notes}</T> : x.withheld ? <T size={12} color={c.mute}>Notes withheld while access is not active.</T> : null}
          {live ? <Btn small title="Edit" color={c.paper} onPress={() => setForm({ type: 'eval', item: x })} style={{ alignSelf: 'flex-start', marginTop: 6 }} /> : null}
        </Card>
      ))}
      <H2>Contact log</H2>
      {!d.data?.contacts.length ? <T size={13} color={c.mute}>Nothing logged.</T> : d.data.contacts.map((k) => (
        <Card key={k.id} pad={12}>
          <T weight="800">{cap1(k.kind)} · {day(k.contacted_on)}</T>
          {k.summary ? <T size={13}>{k.summary}</T> : k.withheld ? <T size={12} color={c.mute}>Summary withheld while access is not active.</T> : null}
          {k.follow_up_on ? <T size={12} color={c.mute}>Follow up {day(k.follow_up_on)}</T> : null}
        </Card>
      ))}
      <Btn small title="Remove from this list" color={c.paper} onPress={archive} style={{ alignSelf: 'flex-start' }} />
      <T size={11} color={c.mute}>Removing archives the entry; your evaluations and history are kept.</T>

      {form?.type === 'eval' ? (
        <FormSheet visible onClose={() => setForm(null)} title={ev ? 'Edit evaluation' : 'New evaluation'} submitLabel="Save"
          initial={ev ? { basis: ev.basis, observed_on: ev.observed_on, overall: ev.overall, ...Object.fromEntries(CRITERIA.map((k) => [k, ev.ratings[k] ?? 0])), notes: ev.notes ?? '' } : { basis: 'live_viewing', observed_on: new Date().toISOString().slice(0, 10), overall: 3, ...Object.fromEntries(CRITERIA.map((k) => [k, 0])), notes: '' }}
          fields={[
            { key: 'basis', label: 'What is this based on?', type: 'chips', options: BASES },
            { key: 'observed_on', label: 'Date observed', type: 'date', max: new Date().toISOString().slice(0, 10) },
            { key: 'overall', label: 'Overall (1–5)', type: 'stepper', min: 1, max: 5 },
            ...CRITERIA.map((k) => ({ key: k, label: `${cap1(k)} (0 = not rated)`, type: 'stepper', min: 0, max: 5 })),
            { key: 'notes', label: 'Private notes', type: 'multiline', optional: true, hint: 'Only you can see these. They are encrypted.' },
          ]}
          onSubmit={async (v) => {
            const ratings = Object.fromEntries(CRITERIA.filter((k) => v[k] > 0).map((k) => [k, v[k]]));
            try {
              if (ev) await api.patch(`/recruiter/evaluations/${ev.id}`, { basis: v.basis, observed_on: v.observed_on, overall: v.overall, ratings, notes: v.notes || null, row_version: ev.row_version });
              else { await api.post(`/recruiter/entries/${e.id}/evaluations`, { basis: v.basis, observed_on: v.observed_on, overall: v.overall, ratings, notes: v.notes || undefined, idempotency_key: evKey.current }); evKey.current = newKey(); }
              setForm(null); reload();
            } catch (x) { throw new Error(say(x)); }
          }}
        />
      ) : null}
      {form?.type === 'contact' ? (
        <FormSheet visible onClose={() => setForm(null)} title="Log a contact" submitLabel="Save"
          initial={{ kind: 'call', contacted_on: new Date().toISOString().slice(0, 10), summary: '' }}
          fields={[
            { key: 'kind', label: 'How', type: 'chips', options: ['call', 'email', 'meeting', 'message', 'other'].map((value) => ({ value, label: cap1(value) })) },
            { key: 'contacted_on', label: 'Date', type: 'date', max: new Date().toISOString().slice(0, 10) },
            { key: 'summary', label: 'What was said', type: 'multiline', optional: true },
            { key: 'follow_up_on', label: 'Follow up on', type: 'date', optional: true, min: new Date().toISOString().slice(0, 10) },
          ]}
          onSubmit={async (v) => {
            try { await api.post(`/recruiter/entries/${e.id}/contacts`, { kind: v.kind, contacted_on: v.contacted_on, summary: v.summary || undefined, follow_up_on: v.follow_up_on || undefined, idempotency_key: ctKey.current }); ctKey.current = newKey(); setForm(null); reload(); } catch (x) { throw new Error(say(x)); }
          }}
        />
      ) : null}
    </Sheet>
  );
}

// ------------------------------------------------------------------ recruiter workspace
function Pipeline({ requests }) {
  const { toast } = useSession();
  const lists = useLoad(() => api.get('/recruiter/lists'), []);
  const [listId, setListId] = useState(null);
  const [stage, setStage] = useState('all');
  const [naming, setNaming] = useState(false);
  const [open, setOpen] = useState(null);
  const [sub, setSub] = useState(null);
  const active = (lists.data ?? []).find((l) => l.id === listId) ?? (lists.data ?? [])[0];
  const entries = useLoad(() => (active ? api.get(`/recruiter/lists/${active.id}/entries`, { stage: stage === 'all' ? undefined : stage, limit: 100 }) : Promise.resolve([])), [active?.id, stage, lists.data]);
  const grants = (requests ?? []).filter((r) => r.live);
  const reloadAll = () => { lists.reload(); entries.reload(); };
  const exportCsv = async () => { try { download(await api.get(`/recruiter/lists/${active.id}/export`)); } catch (e) { toast(say(e)); } };
  const rows = entries.data ?? [];
  return (
    <View style={{ gap: 12 }}>
      <HScroll>
        {(lists.data ?? []).map((l) => <Chip key={l.id} label={`${l.name} · ${l.athletes}`} active={active?.id === l.id} onPress={() => { setListId(l.id); setStage('all'); }} />)}
        <Chip label="+ New list" onPress={() => setNaming(true)} />
      </HScroll>
      {lists.loading && !lists.data ? <Loading /> : lists.error ? <ErrorBox error={lists.error} onRetry={lists.reload} /> : !active ? (
        <Empty emoji="📋" title="No lists yet" sub="Create a list such as “Spring trials”, then save athletes who have allowed you access." />
      ) : (
        <>
          <HScroll>
            <Chip label="All stages" active={stage === 'all'} onPress={() => setStage('all')} />
            {STAGES.map((s) => <Chip key={s} label={`${cap1(s)}${active.stages?.[s] ? ` · ${active.stages[s]}` : ''}`} active={stage === s} onPress={() => setStage(s)} />)}
          </HScroll>
          {entries.loading && !entries.data ? <Loading /> : entries.error ? <ErrorBox error={entries.error} onRetry={entries.reload} /> : !rows.length ? (
            <Empty emoji="🔎" title={stage === 'all' ? 'No athletes saved here' : `Nobody at “${cap1(stage)}”`} sub={grants.length ? 'Add an athlete who has allowed you access.' : 'Ask an athlete for access in Requests first. You can only save athletes who allowed you.'} />
          ) : rows.map((e) => (
            <Card key={e.id} onPress={() => setOpen(e)} pad={14} accessibilityLabel={`${e.redacted ? 'Access ended' : e.athlete.display_name}, ${e.stage}`}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <T weight="800" size={16}>{e.redacted ? 'Access ended' : e.athlete.display_name}</T>
                <Tag label={cap1(e.stage)} />
              </View>
              <T size={12} color={c.mute}>{e.sport_emoji} {e.sport}{e.avg_overall ? ` · ★ ${e.avg_overall} (${e.evaluations})` : ''}{e.last_contact_on ? ` · last contact ${e.last_contact_on}` : ''}</T>
              <View style={{ flexDirection: 'row', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                <Tag label={e.redacted ? NOT_LIVE[e.access] ?? 'Access ended' : `Access live until ${day(e.grant_expires_at)}`} color={e.redacted ? c.pinkSoft : c.lime} />
                {e.next_follow_up_on ? <Tag label={`Follow up ${e.next_follow_up_on}`} color={c.sunSoft} /> : null}
              </View>
            </Card>
          ))}
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            <Btn small title="+ Add athlete" onPress={() => setSub('add')} disabled={!grants.length} />
            <Btn small title="Export CSV" color={c.paper} onPress={exportCsv} />
          </View>
        </>
      )}
      {naming ? (
        <FormSheet visible onClose={() => setNaming(false)} title="New list" submitLabel="Create" initial={{ name: '' }}
          fields={[{ key: 'name', label: 'List name', placeholder: 'e.g. Spring trials' }, { key: 'sport', label: 'Only one sport?', type: 'sport', optional: true }]}
          onSubmit={async (v) => { try { const l = await api.post('/recruiter/lists', { name: v.name, sport: v.sport || undefined }); setListId(l.id); setNaming(false); lists.reload(); } catch (e) { throw new Error(e.details?.code === 'duplicate_list' ? 'You already have a list with that name.' : say(e)); } }}
        />
      ) : null}
      {sub === 'add' && active ? (
        <FormSheet visible onClose={() => setSub(null)} title={`Add to ${active.name}`} submitLabel="Add"
          initial={{ request_id: grants[0]?.id }}
          fields={[{ key: 'request_id', label: 'Athlete', type: 'chips', options: grants.map((r) => ({ value: r.id, label: `${r.athlete_name} · ${r.sport_emoji}` })) }]}
          onSubmit={async (v) => { try { await api.post(`/recruiter/lists/${active.id}/entries`, { request_id: v.request_id }); setSub(null); reloadAll(); } catch (e) { throw new Error(say(e)); } }}
        />
      ) : null}
      {open ? <EntrySheet entry={open} onClose={() => setOpen(null)} onChanged={reloadAll} openThread={(e) => setSub({ thread: e })} openDossier={(e) => setSub({ dossier: e })} /> : null}
      {sub?.thread ? <Thread request={{ id: sub.thread.request_id }} title={`Messages · ${sub.thread.athlete?.display_name ?? ''}`} onClose={() => setSub(null)} /> : null}
      {sub?.dossier ? <Dossier request={{ id: sub.dossier.request_id, athlete_name: sub.dossier.athlete?.display_name }} onClose={() => setSub(null)} /> : null}
    </View>
  );
}

function Requests({ requests, onChanged }) {
  const { toast } = useSession();
  const [asking, setAsking] = useState(false);
  const [view, setView] = useState(null);
  const [talk, setTalk] = useState(null);
  const withdraw = async (r) => { try { await api.post(`/recruiter/requests/${r.id}/withdraw`, { row_version: r.row_version }); toast(r.status === 'requested' ? 'Request withdrawn' : 'Access ended'); onChanged(); } catch (e) { toast(say(e)); onChanged(); } };
  return (
    <View style={{ gap: 10 }}>
      <Btn small title="+ Ask an athlete for access" onPress={() => setAsking(true)} style={{ alignSelf: 'flex-start' }} />
      {!requests.length ? <Empty emoji="🤝" title="No requests yet" sub="Ask an athlete for scoped, time-limited access. They (or their guardian) decide what you see." /> : requests.map((r) => (
        <Card key={r.id} pad={14}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <T weight="800" size={16} style={{ flex: 1 }}>{r.athlete_name}{r.is_youth ? ' · young person' : ''}</T>
            <AccessTag r={r} />
          </View>
          <T size={12} color={c.mute}>{r.sport_emoji} {r.sport} · {cap1(r.purpose)} · asked {(r.live ? r.live_scopes : r.scopes).map((s) => SCOPE_NAME[s]).join(', ')}</T>
          {r.status === 'approved' && !r.live_scopes.length ? null : null}
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            {r.live ? <Btn small title="View" color={c.paper} onPress={() => setView(r)} /> : null}
            {r.live && r.live_scopes.includes('messages') ? <Btn small title="Message" color={c.paper} onPress={() => setTalk(r)} /> : null}
            {['requested', 'approved'].includes(r.status) ? <Btn small title={r.status === 'requested' ? 'Withdraw' : 'End access'} color={c.paper} onPress={() => withdraw(r)} /> : null}
          </View>
        </Card>
      ))}
      {asking ? <RequestAccess onClose={() => setAsking(false)} onDone={onChanged} /> : null}
      {view ? <Dossier request={view} onClose={() => setView(null)} /> : null}
      {talk ? <Thread request={talk} title={`Messages · ${talk.athlete_name}`} onClose={() => setTalk(null)} /> : null}
    </View>
  );
}

function ProfileTab({ data, onChanged }) {
  const { toast } = useSession();
  const [edit, setEdit] = useState(false);
  const p = data.profile;
  return (
    <View style={{ gap: 10 }}>
      <Card pad={14}>
        <T weight="800">{p ? (p.organisation?.name ?? p.org_name ?? 'Organisation not set') : 'Set up your recruiter profile'}</T>
        <T size={13} color={c.mute}>{p ? [p.sports.map((s) => `${s.emoji} ${s.name}`).join(', '), p.regions.join(', ')].filter(Boolean).join(' · ') || 'No sports or regions yet' : 'Tell athletes who you recruit for. Verification confirms it.'}</T>
        {p?.bio ? <T size={13} style={{ marginTop: 6 }}>{p.bio}</T> : null}
        <Btn small title={p ? 'Edit profile' : 'Set up profile'} color={c.paper} onPress={() => setEdit(true)} style={{ alignSelf: 'flex-start', marginTop: 10 }} />
      </Card>
      <T size={12} color={c.mute}>Verification is separate from this profile: open Me → Verification → Verified recruiter and attach your ID and proof you recruit for the organisation. Athletes see whether you are verified right now.</T>
      {edit ? (
        <FormSheet visible onClose={() => setEdit(false)} title="Recruiter profile" submitLabel="Save"
          initial={{ org_name: p?.org_name ?? '', sports: (p?.sports ?? []).map((s) => s.slug), regions: p?.regions ?? [], bio: p?.bio ?? '' }}
          fields={[
            { key: 'org_name', label: 'Organisation', placeholder: 'Club, academy, school or federation you recruit for' },
            { key: 'sports', label: 'Sports you cover', type: 'sports', optional: true },
            { key: 'regions', label: 'Regions', type: 'regions', optional: true },
            { key: 'bio', label: 'About you', type: 'multiline', optional: true },
          ]}
          onSubmit={async (v) => {
            try {
              const all = await api.get('/sports');
              const ids = (v.sports ?? []).map((s) => all.find((x) => x.slug === s)?.id).filter(Boolean);
              await api.post('/recruiter/profile', { org_name: v.org_name || null, sport_ids: ids, regions: v.regions ?? [], bio: v.bio || null, row_version: p?.row_version });
              toast('Saved'); setEdit(false); onChanged();
            } catch (e) { throw new Error(say(e)); }
          }}
        />
      ) : null}
    </View>
  );
}

/** The recruiter workspace: pipeline of saved athletes, access requests and messages, and the recruiter profile. */
export function RecruiterHome() {
  const me = useLoad(() => api.get('/recruiter/profile'), []);
  const reqs = useLoad(() => api.get('/recruiter/requests', { limit: 100 }), []);
  const [tab, setTab] = useState('pipeline');
  const reload = () => { me.reload(); reqs.reload(); };
  const m = me.data;
  return (
    <Screen refreshing={(me.loading || reqs.loading) && !!m} onRefresh={reload} wide>
      <H1>Recruiter</H1>
      <T size={13} color={c.mute}>Scout with permission. You only ever see what an athlete allows, for as long as they allow it.</T>
      {me.loading && !m ? <Loading /> : me.error ? <ErrorBox error={me.error} onRetry={me.reload} /> : (
        <View style={{ gap: 12, marginTop: 12 }}>
          <Card color={m.verified ? c.lime : c.sunSoft} pad={14}>
            <T weight="800">{m.verified ? '✓ Verified recruiter' : 'Not verified yet'}</T>
            <T size={13}>{m.verified ? `${m.active} active · ${m.pending} waiting for an answer` : m.verification ? `Your verification is ${nice(m.verification.status)}. You can’t request access until it is approved.` : 'Verify your identity and the organisation you recruit for (Me → Verification) before asking any athlete for access.'}</T>
          </Card>
          <Seg value={tab} onChange={setTab} options={[{ value: 'pipeline', label: 'Pipeline' }, { value: 'requests', label: 'Requests' }, { value: 'profile', label: 'Profile' }]} />
          {tab === 'pipeline' ? <Pipeline requests={reqs.data} /> : null}
          {tab === 'requests' ? (reqs.loading && !reqs.data ? <Loading /> : reqs.error ? <ErrorBox error={reqs.error} onRetry={reqs.reload} /> : <Requests requests={reqs.data ?? []} onChanged={reload} />) : null}
          {tab === 'profile' ? <ProfileTab data={m} onChanged={reload} /> : null}
        </View>
      )}
    </Screen>
  );
}

// ------------------------------------------------------------------ athlete / guardian: who may see me
/** Recruiter access for you, or for a young person (athlete_id) you are a verified guardian of. */
export function RecruiterAccess({ athlete_id: forAthlete }) {
  const { toast, user } = useSession();
  const q = useLoad(() => api.get('/me/recruiter-requests', { athlete_id: forAthlete, limit: 100 }), [forAthlete]);
  const [decide, setDecide] = useState(null);
  const [talk, setTalk] = useState(null);
  const rows = q.data ?? [];
  const act = async (fn, msg) => { try { await fn(); toast(msg); q.reload(); } catch (e) { toast(e.details?.code === 'guardian_consent_required' ? 'Allow “Recruiters & scouts” under Family → permissions first.' : say(e)); q.reload(); } };
  const waiting = rows.filter((r) => r.status === 'requested' && new Date(r.expires_at) > new Date());
  const live = rows.filter((r) => r.status === 'approved' && r.live);
  const past = rows.filter((r) => !waiting.includes(r) && !live.includes(r));
  const Who = ({ r }) => (
    <View style={{ gap: 2 }}>
      <T weight="800" size={16}>{r.recruiter_name}{r.recruiter_verified ? ' ✓' : ''}</T>
      <T size={12} color={c.mute}>{r.organisation ?? r.org_name ?? 'Organisation not stated'} · {r.recruiter_verified ? 'Verified recruiter' : 'Verification not current'}</T>
      <T size={13}>{r.sport_emoji} {r.sport} · for {r.purpose}</T>
      {r.message ? <T size={13} color={c.mute}>“{r.message}”</T> : null}
    </View>
  );
  return (
    <Screen refreshing={q.loading && !!q.data} onRefresh={q.reload} wide>
      <H1>Recruiter access</H1>
      <T size={13} color={c.mute}>{forAthlete ? 'Decide who may see this young person’s profile.' : 'Verified recruiters can only ask. You decide what they see, for how long, and you can end it at any time.'}</T>
      {q.loading && !q.data ? <Loading /> : q.error ? <ErrorBox error={q.error} onRetry={q.reload} /> : (
        <View style={{ gap: 12, marginTop: 12 }}>
          {!forAthlete && user?.is_youth ? <Card color={c.sunSoft}><T>A parent or guardian decides who can see your profile.</T></Card> : null}
          {!rows.length ? <Empty emoji="🔒" title="No recruiter has asked" sub="Nobody can see your profile as a recruiter unless you approve a request." /> : null}
          {waiting.length ? <H2>Waiting for your answer</H2> : null}
          {waiting.map((r) => (
            <Card key={r.id} pad={14} color={c.sunSoft}>
              <Who r={r} />
              <T size={13} style={{ marginTop: 6 }}>Wants: {r.scopes.map((s) => SCOPE_NAME[s]).join(', ')} until {day(r.expires_at)}</T>
              {!r.recruiter_verified ? <T size={12} color={c.red}>This recruiter’s verification is no longer current — you cannot approve.</T> : null}
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                <Btn small title="Review & approve" onPress={() => setDecide(r)} disabled={!r.recruiter_verified} />
                <Btn small title="Decline" color={c.paper} onPress={() => act(() => api.post(`/me/recruiter-requests/${r.id}/decision`, { decision: 'decline', row_version: r.row_version }), 'Declined')} />
              </View>
            </Card>
          ))}
          {live.length ? <H2>Can see your profile now</H2> : null}
          {live.map((r) => (
            <Card key={r.id} pad={14}>
              <Who r={r} />
              <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>{r.live_scopes.map((s) => <Tag key={s} label={SCOPE_NAME[s]} color={c.lime} />)}<Tag label={`until ${day(r.expires_at)}`} /></View>
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                {r.live_scopes.includes('messages') ? <Btn small title="Messages" color={c.paper} onPress={() => setTalk(r)} /> : null}
                {r.live_scopes.includes('messages') ? <Btn small title="Close chat" color={c.paper} onPress={() => act(() => api.post(`/me/recruiter-requests/${r.id}/thread`, { closed: true }), 'Chat closed')} /> : null}
                <Btn small title="End access now" color={c.red} onPress={() => act(() => api.post(`/me/recruiter-requests/${r.id}/revoke`, {}), 'Access ended')} />
              </View>
            </Card>
          ))}
          {past.length ? <H2>History</H2> : null}
          {past.map((r) => (
            <Card key={r.id} pad={12} color={c.paper}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}><View style={{ flex: 1 }}><Who r={r} /></View><AccessTag r={r} /></View>
              <Btn small title="Read messages" color={c.paper} onPress={() => setTalk(r)} style={{ alignSelf: 'flex-start', marginTop: 6 }} />
            </Card>
          ))}
        </View>
      )}
      {decide ? (
        <FormSheet visible onClose={() => setDecide(null)} title={`Allow ${decide.recruiter_name}?`} submitLabel="Approve"
          initial={{ granted_scopes: decide.scopes, expires_on: day(decide.expires_at), note: '' }}
          fields={[
            { key: 'granted_scopes', label: 'What they may see', type: 'multi', options: decide.scopes.map((s) => ({ value: s, label: SCOPE_NAME[s] })), hint: 'Untick anything you do not want to share.' },
            { key: 'expires_on', label: 'Access until', type: 'date', min: inDays(0), max: day(decide.expires_at), hint: 'You can end it sooner at any time.' },
            { key: 'note', label: 'Note to the recruiter', type: 'multiline', optional: true },
          ]}
          onSubmit={async (v) => {
            try { await api.post(`/me/recruiter-requests/${decide.id}/decision`, { decision: 'approve', granted_scopes: v.granted_scopes, expires_on: v.expires_on, note: v.note || undefined, row_version: decide.row_version }); toast('Access approved'); setDecide(null); q.reload(); }
            catch (e) { throw new Error(e.details?.code === 'guardian_consent_required' ? 'Allow “Recruiters & scouts” under Family → permissions first.' : say(e)); }
          }}
        />
      ) : null}
      {talk ? <Thread request={talk} title={`Messages · ${talk.recruiter_name}`} onClose={() => { setTalk(null); q.reload(); }} /> : null}
    </Screen>
  );
}
