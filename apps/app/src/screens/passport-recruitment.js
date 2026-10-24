import React, { useEffect, useState } from 'react';
import { Linking, Platform, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Empty, ErrorBox, H2, Loading, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c, day } from '../theme';
import { pickMedia } from '../market/media';
import { pickDocument } from './insurance';

const nice = (s) => String(s).replace(/_/g, ' ');
const WEEK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const LEVELS = ['school', 'club', 'regional', 'state', 'national', 'semi_pro'].map((v) => ({ value: v, label: nice(v) }));
const OPEN_TO = ['scholarship', 'trial', 'academy', 'club', 'college', 'relocation'].map((v) => ({ value: v, label: nice(v) }));
const STATUS = { pending: ['Waiting for a coach', c.sunSoft], approved: ['Approved', c.mint], rejected: ['Not approved', c.pinkSoft], pending_athlete: ['Waiting for you', c.sunSoft], declined: ['Declined', c.violetSoft] };

/** Files sit behind the same live checks as the passport, so they are fetched with the sign-in header and shown from a local blob. */
export async function openFile(url) {
  const blob = await api.download(String(url).replace(/^\/api\/v1/, ''));
  if (Platform.OS !== 'web') throw new Error('Open this document on the web version');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.target = '_blank'; a.rel = 'noopener'; a.click();
}

/** Plays a video inside the app: a YouTube/Vimeo link in an embedded player, an uploaded clip from a blob fetched with the viewer's own sign-in. */
export function VideoPlayer({ video }) {
  const { toast } = useSession();
  const [src, setSrc] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => () => { if (src) URL.revokeObjectURL(src); }, [src]);
  const web = Platform.OS === 'web';
  const frame = { width: '100%', aspectRatio: '16 / 9', border: 0, borderRadius: 14, background: '#0F172A', display: 'block' };
  if (video.embed_url && web) return React.createElement('iframe', { src: video.embed_url, title: video.title, style: frame, allow: 'accelerometer; encrypted-media; picture-in-picture; fullscreen', allowFullScreen: true, loading: 'lazy', referrerPolicy: 'strict-origin-when-cross-origin' });
  if (video.file_url && web) {
    if (src) return React.createElement('video', { src, controls: true, autoPlay: true, playsInline: true, 'aria-label': video.title, style: { ...frame, objectFit: 'contain' } });
    const load = async () => {
      setBusy(true);
      try { setSrc(URL.createObjectURL(await api.download(String(video.file_url).replace(/^\/api\/v1/, '')))); } catch (e) { toast(e.message); } finally { setBusy(false); }
    };
    return <Btn small title={busy ? 'Loading…' : '▶ Play clip'} onPress={load} disabled={busy} style={{ alignSelf: 'flex-start' }} />;
  }
  return video.link_url ? <Btn small title="Open video" color={c.paper} ink={c.ink} onPress={() => Linking.openURL(video.link_url)} style={{ alignSelf: 'flex-start' }} /> : <T size={12} color={c.mute}>Open this clip on the web version to play it.</T>;
}

/** Recruitment sections of a shared passport: only what the athlete's link shows, with who vouched for it. */
export function RecruitmentSections({ data }) {
  const toast = useSession()?.toast ?? (() => {});
  const open = (url) => openFile(url).catch((e) => toast(e.message));
  const p = data.preferences;
  return (
    <>
      {data.videos?.length ? (
        <Card pad={16}>
          <H2>Video</H2>
          <T size={12} color={c.mute} style={{ marginTop: 2 }}>Each clip was approved by a coach who coaches this athlete.</T>
          {data.videos.map((v) => (
            <View key={v.id} style={{ marginTop: 10, gap: 4 }}>
              <T weight="700">{v.title}</T>
              <T size={12} color={c.mute}>{[v.sport_slug && nice(v.sport_slug), v.approved_by && `approved by ${v.approved_by}`].filter(Boolean).join(' · ')}</T>
              <VideoPlayer video={v} />
            </View>
          ))}
        </Card>
      ) : null}
      {data.references?.length ? (
        <Card pad={16}>
          <H2>Coach references</H2>
          <T size={12} color={c.mute} style={{ marginTop: 2 }}>Written by the coach and approved by the athlete.</T>
          {data.references.map((r) => (
            <View key={r.id} style={{ marginTop: 12 }}>
              <T>“{r.body}”</T>
              <T size={12} color={c.mute} style={{ marginTop: 4 }}>— {r.coach_name}{r.sport_slug ? ` · ${nice(r.sport_slug)}` : ''} · {day(r.created_at)}</T>
            </View>
          ))}
        </Card>
      ) : null}
      {p ? (
        <Card pad={16}>
          <H2>Looking for</H2>
          {p.open_to.length || p.sport_slugs.length || p.regions.length || p.levels.length ? (
            <View style={{ gap: 6, marginTop: 8 }}>
              {p.open_to.length ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{p.open_to.map((o) => <Tag key={o} label={nice(o)} color={c.violetSoft} />)}</View> : null}
              {p.sport_slugs.length ? <T size={13}>Sports: {p.sport_slugs.map(nice).join(', ')}</T> : null}
              {p.levels.length ? <T size={13}>Levels: {p.levels.map(nice).join(', ')}</T> : null}
              {p.regions.length ? <T size={13}>Regions: {p.regions.join(', ')}</T> : null}
              <T size={13} weight="700">{p.open_to_contact ? 'Happy to be contacted by recruiters' : 'Not open to unsolicited contact'}</T>
              {p.notes ? <T size={13} color={c.mute}>{p.notes}</T> : null}
            </View>
          ) : <T size={13} color={c.mute} style={{ marginTop: 6 }}>The athlete has not set preferences yet.</T>}
        </Card>
      ) : null}
      {data.availability ? (
        <Card pad={16}>
          <H2>Availability</H2>
          {data.availability.length ? data.availability.map((a) => (
            <T key={a.id} style={{ marginTop: 8 }} size={13}><T weight="700">{nice(a.kind)}</T> · {day(a.from_date)} – {day(a.to_date)}{a.weekdays.length ? ` · ${a.weekdays.map((d) => WEEK[d]).join(', ')}` : ''}{a.from_time ? ` · ${a.from_time}–${a.to_time}` : ''}{a.note ? ` · ${a.note}` : ''}</T>
          )) : <T size={13} color={c.mute} style={{ marginTop: 6 }}>No upcoming windows.</T>}
        </Card>
      ) : null}
      {data.academic?.length ? (
        <Card pad={16}>
          <H2>Academic evidence</H2>
          <T size={12} color={c.mute} style={{ marginTop: 2 }}>Entered by the athlete; labelled as self-reported unless the institution issued it.</T>
          {data.academic.map((a) => (
            <View key={a.id} style={{ marginTop: 10, gap: 3 }}>
              <T weight="700">{nice(a.kind)} · {a.institution}</T>
              <T size={12} color={c.mute}>{a.period_from ? `${day(a.period_from)}${a.period_to ? ` – ${day(a.period_to)}` : ''} · ` : ''}{a.provenance === 'self_reported' ? 'self-reported, not verified' : 'issued by the institution'}</T>
              {a.summary ? <T size={13}>{a.summary}</T> : null}
              {a.file_url ? <Btn small title="Open document" color={c.paper} ink={c.ink} onPress={() => open(a.file_url)} style={{ alignSelf: 'flex-start' }} /> : null}
            </View>
          ))}
        </Card>
      ) : null}
    </>
  );
}

const Row = ({ title, sub, tag, above, children }) => (
  <Card pad={12} color={c.paper} style={{ marginTop: 8 }}>
    <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
      <View style={{ flex: 1 }}><T weight="700">{title}</T>{sub ? <T size={12} color={c.mute}>{sub}</T> : null}</View>
      {tag ? <Tag label={tag[0]} color={tag[1]} /> : null}
    </View>
    {above ? <View style={{ marginTop: 8 }}>{above}</View> : null}
    {children ? <View style={{ flexDirection: 'row', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>{children}</View> : null}
  </Card>
);
const Block = ({ title, sub, action, state, empty, children }) => (
  <Card pad={16} style={{ marginTop: 14 }}>
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
      <View style={{ flex: 1 }}><H2>{title}</H2>{sub ? <T size={12} color={c.mute}>{sub}</T> : null}</View>
      {action}
    </View>
    {state.error ? <ErrorBox error={state.error} onRetry={state.reload} /> : !state.data ? <Loading /> : !(Array.isArray(state.data) ? state.data.length : true) ? <Empty emoji={empty[0]} title={empty[1]} sub={empty[2]} /> : children}
  </Card>
);

/** The athlete's recruitment profile: everything a link can show, each item with where it stands (pending, approved, self-reported). */
export function RecruitmentProfile() {
  const { toast } = useSession();
  const videos = useLoad(() => api.get('/me/passport-videos'), []);
  const refs = useLoad(() => api.get('/me/passport-references'), []);
  const prefs = useLoad(() => api.get('/me/recruitment-preferences'), []);
  const avail = useLoad(() => api.get('/me/recruitment-availability'), []);
  const acad = useLoad(() => api.get('/me/academic-evidence'), []);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const act = async (fn, msg, state) => { try { await fn(); toast(msg); await state.reload(); } catch (e) { toast(e.message); } };
  const uploadClip = async () => {
    const f = await pickMedia();
    if (!f) return;
    const title = (f.name || 'Clip').replace(/\.[^.]+$/, '').slice(0, 120);
    setBusy(true);
    try { await api.upload('/me/passport-videos/upload', f.blob, { title }); toast('Uploaded. A coach needs to approve it.'); await videos.reload(); } catch (e) { toast(e.message); } finally { setBusy(false); }
  };
  const attach = async (a) => {
    const f = await pickDocument();
    if (!f) return;
    setBusy(true);
    try { await api.upload(`/me/academic-evidence/${a.id}/file`, f.blob); toast('Document attached'); await acad.reload(); } catch (e) { toast(e.message); } finally { setBusy(false); }
  };
  const pf = prefs.data;
  return (
    <View>
      <H2 style={{ marginTop: 26 }}>Recruitment profile</H2>
      <T size={12} color={c.mute} style={{ marginTop: 2 }}>Add what recruiters ask for. Nothing is shared until you switch it on for a link, and videos and references only count once approved.</T>

      <Block title="Video" sub="A coach who coaches you must approve each clip." state={videos} empty={['🎬', 'No videos yet', 'Upload a clip (MP4, MOV or WebM, up to 50 MB) or add a YouTube or Vimeo link.']}
        action={<View style={{ flexDirection: 'row', gap: 6 }}><Btn small title={busy ? 'Uploading…' : 'Upload'} onPress={uploadClip} disabled={busy} /><Btn small title="Link" color={c.paper} ink={c.ink} onPress={() => setForm('video')} /></View>}>
        {videos.data?.map((v) => (
          <Row key={v.id} title={v.title} sub={[v.has_file ? 'uploaded clip' : 'link', v.review_note].filter(Boolean).join(' · ')} tag={STATUS[v.status]} above={<VideoPlayer video={v.has_file ? { ...v, file_url: `/passport-videos/${v.id}/file` } : v} />}>
            <Btn small title="Remove" color={c.paper} ink={c.red} onPress={() => act(() => api.del(`/me/passport-videos/${v.id}`), 'Video removed', videos)} />
          </Row>
        ))}
      </Block>

      <Block title="Coach references" sub="A coach writes it; you approve it before it can be shared." state={refs} empty={['✍️', 'No references yet', 'Ask a coach you train with to write one (Coach home → Recruitment).']}>
        {refs.data?.map((r) => (
          <Row key={r.id} title={`${r.coach_name}${r.sport_slug ? ` · ${nice(r.sport_slug)}` : ''}`} sub={r.body} tag={STATUS[r.status]}>
            {r.status === 'pending_athlete' ? <>
              <Btn small title="Approve" onPress={() => act(() => api.post(`/me/passport-references/${r.id}/decision`, { version: r.version, decision: 'approved' }), 'Reference approved', refs)} />
              <Btn small title="Decline" color={c.paper} ink={c.red} onPress={() => act(() => api.post(`/me/passport-references/${r.id}/decision`, { version: r.version, decision: 'declined' }), 'Reference declined', refs)} />
            </> : <Btn small title="Remove" color={c.paper} ink={c.red} onPress={() => act(() => api.del(`/passport-references/${r.id}`), 'Reference removed', refs)} />}
          </Row>
        ))}
      </Block>

      <Block title="What I'm looking for" state={prefs} empty={[]} action={<Btn small title={pf?.version ? 'Edit' : 'Set up'} onPress={() => setForm('prefs')} />}>
        {pf?.version ? <View style={{ gap: 6, marginTop: 8 }}>
          <T size={13}>{[pf.open_to.map(nice).join(', '), pf.sport_slugs.map(nice).join(', '), pf.regions.join(', ')].filter(Boolean).join(' · ') || 'Saved'}</T>
          <T size={12} color={c.mute}>{pf.open_to_contact ? 'Recruiters may contact you' : 'No unsolicited contact'}</T>
        </View> : <T size={13} color={c.mute} style={{ marginTop: 8 }}>Not set yet.</T>}
      </Block>

      <Block title="Availability" sub="Upcoming trials, visits and start dates." state={avail} empty={['📅', 'No windows yet', 'Add when you can attend a trial or visit.']} action={<Btn small title="+ Add" onPress={() => setForm('avail')} />}>
        {avail.data?.map((a) => (
          <Row key={a.id} title={`${nice(a.kind)} · ${day(a.from_date)} – ${day(a.to_date)}`} sub={[a.weekdays.length && a.weekdays.map((d) => WEEK[d]).join(', '), a.from_time && `${a.from_time}–${a.to_time}`, a.note].filter(Boolean).join(' · ')}>
            <Btn small title="Remove" color={c.paper} ink={c.red} onPress={() => act(() => api.del(`/me/recruitment-availability/${a.id}`), 'Window removed', avail)} />
          </Row>
        ))}
      </Block>

      <Block title="Academic evidence (optional)" sub="Marked self-reported: it is never presented as verified." state={acad} empty={['🎓', 'Nothing added', 'Add a transcript, certificate or test score if you want recruiters to see it.']} action={<Btn small title="+ Add" onPress={() => setForm('acad')} />}>
        {acad.data?.map((a) => (
          <Row key={a.id} title={`${nice(a.kind)} · ${a.institution}`} sub={a.has_file ? 'document attached' : 'no document yet'} tag={[nice(a.provenance), c.violetSoft]}>
            <Btn small title={a.has_file ? 'Replace file' : 'Attach file'} color={c.paper} ink={c.ink} onPress={() => attach(a)} disabled={busy} />
            <Btn small title="Remove" color={c.paper} ink={c.red} onPress={() => act(() => api.del(`/me/academic-evidence/${a.id}`), 'Removed', acad)} />
          </Row>
        ))}
      </Block>

      {form === 'video' ? <FormSheet visible onClose={() => setForm(null)} title="Add a video link" submitLabel="Add" fields={[
        { key: 'title', label: 'Title' }, { key: 'link_url', label: 'YouTube or Vimeo link', type: 'url', hint: 'It plays inside the app. For other hosts, upload the clip instead.' }, { key: 'sport_slug', label: 'Sport', type: 'sport', optional: true }]}
        onSubmit={async (v) => { await api.post('/me/passport-videos', { title: v.title, link_url: v.link_url, sport_slug: v.sport_slug || undefined }); await videos.reload(); return 'Added. A coach needs to approve it.'; }} /> : null}
      {form === 'prefs' ? <FormSheet visible onClose={() => setForm(null)} title="What I'm looking for" submitLabel="Save"
        initial={{ sport_slugs: pf?.sport_slugs ?? [], levels: pf?.levels ?? [], regions: pf?.regions ?? [], open_to: pf?.open_to ?? [], open_to_contact: !!pf?.open_to_contact, notes: pf?.notes ?? '' }}
        fields={[
          { key: 'open_to', label: 'Open to', type: 'multi', options: OPEN_TO, optional: true },
          { key: 'sport_slugs', label: 'Sports', type: 'sports', optional: true },
          { key: 'levels', label: 'Levels', type: 'multi', options: LEVELS, optional: true },
          { key: 'regions', label: 'Regions', type: 'regions', optional: true },
          { key: 'open_to_contact', label: 'Recruiters may contact me', type: 'switch' },
          { key: 'notes', label: 'Anything else', type: 'multiline', optional: true }]}
        onSubmit={async (v) => { await api.post('/me/recruitment-preferences', { version: pf?.version ?? 0, sport_slugs: v.sport_slugs ?? [], levels: v.levels ?? [], regions: v.regions ?? [], open_to: v.open_to ?? [], open_to_contact: !!v.open_to_contact, notes: v.notes || undefined }); await prefs.reload(); return 'Saved'; }} /> : null}
      {form === 'avail' ? <FormSheet visible onClose={() => setForm(null)} title="Add availability" submitLabel="Add" initial={{ kind: 'trial' }}
        fields={[
          { key: 'kind', label: 'For', type: 'chips', options: [{ value: 'trial', label: 'Trial' }, { value: 'visit', label: 'Visit' }, { value: 'start', label: 'Start date' }] },
          { key: 'from_date', label: 'From and to', type: 'daterange', toKey: 'to_date' },
          { key: 'weekdays', label: 'On these days', type: 'weekdays', optional: true },
          { key: 'from_time', label: 'Earliest time', type: 'time', optional: true },
          { key: 'to_time', label: 'Latest time', type: 'time', optional: true },
          { key: 'note', label: 'Note', optional: true }]}
        onSubmit={async (v) => { await api.post('/me/recruitment-availability', { kind: v.kind, from_date: v.from_date, to_date: v.to_date, weekdays: v.weekdays ?? [], from_time: v.from_time || undefined, to_time: v.to_time || undefined, note: v.note || undefined }); await avail.reload(); return 'Added'; }} /> : null}
      {form === 'acad' ? <FormSheet visible onClose={() => setForm(null)} title="Add academic evidence" submitLabel="Add" initial={{ kind: 'transcript' }}
        fields={[
          { key: 'kind', label: 'Type', type: 'chips', options: [{ value: 'transcript', label: 'Transcript' }, { value: 'certificate', label: 'Certificate' }, { value: 'report', label: 'Report' }, { value: 'test_score', label: 'Test score' }, { value: 'other', label: 'Other' }] },
          { key: 'institution', label: 'School or institution' },
          { key: 'period_from', label: 'From', type: 'date', optional: true }, { key: 'period_to', label: 'To', type: 'date', optional: true },
          { key: 'summary', label: 'Summary (kept private until you share)', type: 'multiline', optional: true }]}
        onSubmit={async (v) => { await api.post('/me/academic-evidence', { kind: v.kind, institution: v.institution, period_from: v.period_from || undefined, period_to: v.period_to || undefined, summary: v.summary || undefined }); await acad.reload(); return 'Added. Attach the document from the list.'; }} /> : null}
    </View>
  );
}

/** Coaches: approve or reject videos of athletes they coach, and write a reference. */
export function CoachPassportDesk() {
  const { toast, user } = useSession();
  const q = useLoad(() => api.get('/coach/passport-videos'), []);
  const [form, setForm] = useState(false);
  if (!user?.roles?.includes('coach')) return null;
  const decide = async (v, decision) => { try { await api.post(`/passport-videos/${v.id}/review`, { version: v.version, decision }); toast(decision === 'approved' ? 'Video approved' : 'Video not approved'); await q.reload(); } catch (e) { toast(e.message); } };
  return (
    <Block title="Athletes you coach" sub="Approve clips that show the athlete, and write references they can share." state={q} empty={['🎬', 'Nothing to review', 'Clips from athletes you coach will appear here.']}
      action={<Btn small title="Write a reference" onPress={() => setForm(true)} />}>
      {q.data?.map((v) => (
        <Row key={v.id} title={v.title} sub={`${v.athlete_name} (@${v.athlete_handle}) · ${v.has_file ? 'uploaded clip' : 'link'}`} above={<VideoPlayer video={v.has_file ? { ...v, file_url: `/passport-videos/${v.id}/file` } : v} />}>
          <Btn small title="Approve" onPress={() => decide(v, 'approved')} />
          <Btn small title="Reject" color={c.paper} ink={c.red} onPress={() => decide(v, 'rejected')} />
        </Row>
      ))}
      {form ? <FormSheet visible onClose={() => setForm(false)} title="Write a reference" submitLabel="Send to athlete for approval"
        fields={[{ key: 'athlete_id', label: 'Athlete', type: 'entity', noun: 'athlete', role: 'athlete' }, { key: 'sport_slug', label: 'Sport', type: 'sport', optional: true }, { key: 'body', label: 'Reference (20–1500 characters)', type: 'multiline' }]}
        onSubmit={async (v) => { await api.post(`/athletes/${v.athlete_id}/passport-references`, { body: v.body, sport_slug: v.sport_slug || undefined }); return 'Sent. It can be shared once the athlete approves it.'; }} /> : null}
    </Block>
  );
}

/** Guardians arrange sharing for a young person (needs their "Recruitment sharing" permission under Family). */
export function GuardianPassports({ onCreated }) {
  const { toast } = useSession();
  const links = useLoad(() => api.get('/youth/guardian-links', { limit: 100 }), []);
  const [child, setChild] = useState(null);
  const kids = (links.data ?? []).filter((l) => l.my_side === 'guardian' && l.status === 'active');
  if (!kids.length) return null;
  return (
    <Card pad={16} style={{ marginTop: 14 }}>
      <H2>Young people you look after</H2>
      <T size={12} color={c.mute}>Allow “Recruitment sharing” for them under Family, then create a link here. Withdrawing the permission stops every link at once.</T>
      {kids.map((l) => <Row key={l.id} title={l.child?.display_name}><Btn small title="New link for them" onPress={() => setChild(l.child)} /></Row>)}
      {child ? <FormSheet visible onClose={() => setChild(null)} title={`Passport link for ${child.display_name}`} submitLabel="Create link"
        initial={{ expires_in_days: 30, show_matches: true, show_results: true, show_awards: false, show_credentials: false }}
        fields={[
          { key: 'label', label: 'Who is it for', optional: true },
          { key: 'recipient_id', label: 'Only this person may open it', type: 'entity', noun: 'person', optional: true },
          { key: 'expires_in_days', label: 'Stops working after', type: 'chips', options: [{ value: 7, label: '7 days' }, { value: 30, label: '30 days' }, { value: 90, label: '90 days' }] },
          { key: 'show_matches', label: 'Match history', type: 'switch' }, { key: 'show_results', label: 'Approved results', type: 'switch' },
          { key: 'show_video', label: 'Approved video', type: 'switch' }, { key: 'show_references', label: 'Coach references', type: 'switch' },
          { key: 'show_preferences', label: 'Preferences', type: 'switch' }, { key: 'show_availability', label: 'Availability', type: 'switch' }]}
        onSubmit={async (v) => { const l = await api.post('/me/passport-links', { athlete_id: child.id, label: v.label || undefined, recipient_id: v.recipient_id || undefined, expires_in_days: Number(v.expires_in_days), ...Object.fromEntries(['show_matches', 'show_results', 'show_video', 'show_references', 'show_preferences', 'show_availability'].map((k) => [k, !!v[k]])) }); onCreated?.(l); return 'Link created'; }} /> : null}
    </Card>
  );
}
