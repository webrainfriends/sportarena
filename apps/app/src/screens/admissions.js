// Admissions desk of an institution (a tab inside the organisation workspace): the public listing, programmes and brochures,
// the enquiry inbox, announcements to consenting enquirers, and the certificates the institution has issued.
// The server decides who may do what; this screen only hides what an admissions role cannot use.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { Btn, Card, Chip, Empty, ErrorBox, Field, Loading, Row, Section, Seg, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { useSports } from '../sportpicker';
import { c, when } from '../theme';
import { moneyIn } from '../vtime';
import { KINDS, MODES, STAGES, label } from './pathways';
import { whoForFields, whoForInitial, whoForBody } from '../who-for';

const fail = (toast) => (e) => toast('' + e.message);
const OPEN_STAGES = ['new', 'in_conversation', 'referred', 'applied', 'admitted'];
const opts = (list) => list.map(([value, l]) => ({ value, label: l }));

export function Admissions({ o, role, archived, toast }) {
  const [tab, setTab] = useState('inbox');
  const staff = role === 'owner' || role === 'admin';
  const sum = useLoad(() => (staff ? api.get(`/organisations/${o.id}/admissions`) : Promise.resolve(null)), [o.id]);
  if (!staff) return <Empty emoji="🔒" title="Admissions is for owners and admins" sub="Ask an owner to make you an admin to answer enquiries." />;
  if (sum.error) return <ErrorBox error={sum.error} onRetry={sum.reload} />;
  if (!sum.data) return <Loading />;
  const s = sum.data;
  const P = { o, archived, toast, reload: sum.reload };
  return (
    <>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
        <Tag label={s.listed ? 'Listed in the directory' : 'Not listed yet'} color={s.listed ? c.lime : c.orangeSoft} />
        <Tag label={`${s.stages.new} new`} /><Tag label={`${s.unread} unread`} /><Tag label={`${s.consenting} accept announcements`} /><Tag label={`${s.programmes} programmes`} />
      </View>
      <View style={{ marginTop: 10 }}>
        <Seg value={tab} onChange={setTab} color={c.violet} options={[{ value: 'inbox', label: 'Enquiries' }, { value: 'programmes', label: 'Programmes' }, { value: 'announce', label: 'Announce' }, { value: 'credentials', label: 'Certificates' }, { value: 'profile', label: 'Listing' }]} />
      </View>
      {tab === 'inbox' ? <Inbox {...P} /> : tab === 'programmes' ? <Programmes {...P} /> : tab === 'announce' ? <Announce {...P} /> : tab === 'credentials' ? <Issued {...P} /> : <Listing {...P} />}
    </>
  );
}

function Inbox({ o }) {
  const { push } = useNav();
  const [status, setStatus] = useState(null), [q, setQ] = useState(''), [mine, setMine] = useState(false);
  const list = useLoad(() => api.get(`/organisations/${o.id}/enquiries`, { status: status || undefined, q: q.trim() || undefined, mine: mine || undefined, limit: 100 }), [o.id, status, q, mine]);
  return (
    <Section title="Enquiries" color={c.sun}>
      <Field value={q} onChangeText={setQ} placeholder="Search by athlete name or handle…" />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        <Chip label="All" active={!status} onPress={() => setStatus(null)} />
        {STAGES.map(([k, l]) => <Chip key={k} label={l} active={status === k} onPress={() => setStatus(status === k ? null : k)} />)}
        <Chip label="Assigned to me" active={mine} onPress={() => setMine(!mine)} />
      </View>
      {list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !list.data ? <Loading /> : list.data.length ? list.data.map((e) => (
        <Row key={e.id} title={`${e.unread ? '● ' : ''}${e.athlete_name} (@${e.athlete_handle})`} sub={`${e.programme_title ?? 'General enquiry'}${e.sport ? ` · ${e.sport_emoji} ${e.sport}` : ''}${e.comms_consent ? ' · accepts announcements' : ''}\n${when(e.last_message_at)}`}
          right={<Tag label={label(STAGES, e.status)} />} onPress={() => push('Enquiry', { id: e.id })} />
      )) : <Empty emoji="📭" title="No enquiries" sub="Once your institution is listed, athletes can ask about it and its programmes here." />}
    </Section>
  );
}

function Programmes({ o, archived, toast, reload }) {
  const sports = useSports();
  const [form, setForm] = useState(null), [bro, setBro] = useState(false);
  const progs = useLoad(() => api.get(`/organisations/${o.id}/programmes`, { limit: 100 }), [o.id]);
  const bros = useLoad(() => api.get(`/organisations/${o.id}/brochures`, { limit: 100 }), [o.id]);
  const idsOf = (slugs = []) => slugs.map((sl) => (sports.data ?? []).find((s) => s.slug === sl)?.id).filter(Boolean);
  const slugsOf = (p) => (p.sports ?? []).map((s) => s.slug);
  const refresh = () => { progs.reload(); bros.reload(); reload(); };
  const setStatus = async (p, status) => { try { await api.patch(`/programmes/${p.id}`, { status }); refresh(); } catch (e) { fail(toast)(e); } };
  const setBro_ = async (b, status) => { try { await api.patch(`/brochures/${b.id}`, { status }); refresh(); } catch (e) { fail(toast)(e); } };
  const edit = form && form !== 'new' ? form : null;
  const fields = [
    { key: 'title', label: 'Programme name' },
    { key: 'kind', label: 'Level', type: 'chips', options: opts(KINDS), default: 'course' },
    { key: 'mode', label: 'How it is taught', type: 'chips', options: opts(MODES), default: 'on_campus' },
    { key: 'sports', label: 'Sports it covers (leave empty for a general sports programme)', type: 'sports', optional: true },
    { key: 'description', label: 'About the programme', type: 'multiline', optional: true },
    { key: 'duration_months', label: 'Duration in months', type: 'stepper', min: 1, max: 120, default: 12 },
    { key: 'currency', label: 'Fee currency', type: 'currency' },
    { key: 'fee_minor', label: 'Fee', type: 'money', currency: (v) => v.currency ?? 'INR', optional: true },
    { key: 'next_intake_on', label: 'Next intake', type: 'date', optional: true },
    { key: 'apply_url', label: 'Where to apply (https link on your website)', type: 'url', optional: true },
    ...whoForFields(),
  ];
  return (
    <>
      <Section title="Programmes" color={c.cyan}>
        {progs.error ? <ErrorBox error={progs.error} onRetry={progs.reload} /> : !progs.data ? <Loading /> : progs.data.length ? progs.data.map((p) => (
          <Card key={p.id} pad={14}>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><T weight="700" style={{ flex: 1 }}>{p.title}</T><Tag label={p.status === 'active' ? 'Active' : 'Archived'} /></View>
            <T size={12} color={c.mute}>{label(KINDS, p.kind)} · {label(MODES, p.mode)}{p.sports.length ? ` · ${p.sports.map((s) => s.emoji).join(' ')}` : ''} · {p.enquiries} enquir{p.enquiries === 1 ? 'y' : 'ies'}{p.fee_minor != null ? ` · ${moneyIn(p.fee_minor, p.currency)}` : ''}</T>
            {!archived ? <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}><Btn small title="Edit" color={c.paper} ink={c.ink} onPress={() => setForm(p)} /><Btn small title={p.status === 'active' ? 'Archive' : 'Restore'} color={c.paper} ink={p.status === 'active' ? c.red : c.ink} onPress={() => setStatus(p, p.status === 'active' ? 'archived' : 'active')} /></View> : null}
          </Card>
        )) : <Empty emoji="🎓" title="No programmes yet" sub="Publish the courses, certifications and degrees you teach so athletes can find them." />}
        {!archived ? <Btn small title="Add a programme" onPress={() => setForm('new')} style={{ alignSelf: 'flex-start' }} /> : null}
      </Section>
      <Section title="Brochures" color={c.sun}>
        {bros.data?.length ? bros.data.map((b) => (
          <Row key={b.id} title={b.title} sub={`${b.programme_title ?? 'General'} · ${b.status === 'active' ? 'Active' : 'Archived'}`}
            right={!archived ? <Btn small title={b.status === 'active' ? 'Archive' : 'Restore'} color={c.paper} ink={c.ink} onPress={() => setBro_(b, b.status === 'active' ? 'archived' : 'active')} /> : null} />
        )) : <Empty emoji="📄" title="No brochures yet" sub="Add a link to a brochure on your site, then share it inside any conversation." />}
        {!archived ? <Btn small title="Add a brochure" color={c.violet} onPress={() => setBro(true)} style={{ alignSelf: 'flex-start' }} /> : null}
      </Section>
      <FormSheet visible={!!form} onClose={() => setForm(null)} title={edit ? 'Edit programme' : 'New programme'} submitLabel={edit ? 'Save' : 'Publish'} fields={fields}
        initial={edit ? { ...edit, sports: slugsOf(edit), ...whoForInitial(edit) } : { currency: 'INR', ...whoForInitial() }}
        onSubmit={async (v) => {
          const body = { title: v.title, kind: v.kind, mode: v.mode, description: v.description, sport_ids: idsOf(v.sports), duration_months: v.duration_months, currency: v.fee_minor != null ? v.currency : undefined, fee_minor: v.fee_minor, next_intake_on: v.next_intake_on, apply_url: v.apply_url, ...whoForBody(v, { clear: !!edit }) };
          if (edit) await api.patch(`/programmes/${edit.id}`, { ...body, sport_ids: idsOf(v.sports) }); else await api.post(`/organisations/${o.id}/programmes`, body);
          refresh(); return edit ? 'Saved' : 'Programme published';
        }} />
      <FormSheet visible={bro} onClose={() => setBro(false)} title="Add a brochure" submitLabel="Add"
        fields={[{ key: 'title', label: 'Title' }, { key: 'url', label: 'Link to the document (https)', type: 'url' }, { key: 'programme_id', label: 'Programme (leave empty for all)', type: 'chips', optional: true, options: (progs.data ?? []).filter((p) => p.status === 'active').map((p) => ({ value: p.id, label: p.title })) }]}
        onSubmit={async (v) => { await api.post(`/organisations/${o.id}/brochures`, v); refresh(); return 'Brochure added'; }} />
    </>
  );
}

function Announce({ o, archived, toast, reload }) {
  const [f, setF] = useState({ subject: '', body: '', programme_id: null, statuses: [], brochure_id: null });
  const [pre, setPre] = useState(null), [busy, setBusy] = useState(false);
  const progs = useLoad(() => api.get(`/organisations/${o.id}/programmes`, { limit: 100 }), [o.id]);
  const bros = useLoad(() => api.get(`/organisations/${o.id}/brochures`, { limit: 100 }), [o.id]);
  const past = useLoad(() => api.get(`/organisations/${o.id}/broadcasts`, { limit: 20 }), [o.id]);
  const set = (k, v) => { setF((p) => ({ ...p, [k]: v })); setPre(null); };
  const body = (dry) => ({ subject: f.subject.trim(), body: f.body.trim(), programme_id: f.programme_id || undefined, statuses: f.statuses.length ? f.statuses : undefined, brochure_id: f.brochure_id || undefined, dry_run: dry });
  const preview = async () => { try { setPre(await api.post(`/organisations/${o.id}/broadcasts`, body(true))); } catch (e) { fail(toast)(e); } };
  const send = async () => {
    setBusy(true);
    try { const r = await api.post(`/organisations/${o.id}/broadcasts`, body(false)); toast(`Sent to ${r.recipients} people`); setF({ subject: '', body: '', programme_id: null, statuses: [], brochure_id: null }); setPre(null); past.reload(); reload(); } catch (e) { fail(toast)(e); } finally { setBusy(false); }
  };
  const ready = f.subject.trim().length >= 2 && f.body.trim().length >= 2;
  return (
    <>
      <Section title="Announce to enquirers" color={c.mint}>
        <T size={13} color={c.mute}>Goes only to people who agreed to announcements when they enquired (or later). It lands in their conversation and they are notified by app, push and email according to their own settings.</T>
        <Field label="Subject" value={f.subject} onChangeText={(x) => set('subject', x)} maxLength={120} />
        <Field label="Message" value={f.body} onChangeText={(x) => set('body', x)} multiline maxLength={4000} />
        <T weight="800" size={13}>Who (optional filters)</T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          <Chip label="All programmes" active={!f.programme_id} onPress={() => set('programme_id', null)} />
          {(progs.data ?? []).filter((p) => p.status === 'active').map((p) => <Chip key={p.id} label={p.title} active={f.programme_id === p.id} onPress={() => set('programme_id', f.programme_id === p.id ? null : p.id)} />)}
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {STAGES.filter(([k]) => OPEN_STAGES.includes(k)).map(([k, l]) => <Chip key={k} label={l} active={f.statuses.includes(k)} onPress={() => set('statuses', f.statuses.includes(k) ? f.statuses.filter((x) => x !== k) : [...f.statuses, k])} />)}
        </View>
        {bros.data?.some((b) => b.status === 'active') ? (
          <>
            <T weight="800" size={13}>Attach a brochure (optional)</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{bros.data.filter((b) => b.status === 'active').map((b) => <Chip key={b.id} label={b.title} active={f.brochure_id === b.id} onPress={() => set('brochure_id', f.brochure_id === b.id ? null : b.id)} />)}</View>
          </>
        ) : null}
        {pre ? <Card color={c.mintSoft}><T weight="700">{pre.recipients} {pre.recipients === 1 ? 'person' : 'people'} will get this</T><T size={12} color={c.mute}>{pre.skipped_no_consent} left out because they did not agree to announcements.</T></Card> : null}
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Btn small title="Check who gets it" color={c.paper} ink={c.ink} disabled={!ready || archived} onPress={preview} />
          <Btn small title={pre ? `Send to ${pre.recipients}` : 'Send'} disabled={!ready || !pre || !pre.recipients || archived} loading={busy} onPress={send} />
        </View>
      </Section>
      <Section title="Sent announcements" color={c.sun}>
        {past.data?.length ? past.data.map((b) => <Row key={b.id} title={b.subject} sub={`${when(b.created_at)} · ${b.recipients} sent · ${b.skipped_no_consent} skipped (no consent) · by ${b.sent_by_name}`} />) : <Empty emoji="📣" title="Nothing sent yet" />}
      </Section>
    </>
  );
}

function Issued({ o, archived, toast }) {
  const [revoke, setRevoke] = useState(null);
  const list = useLoad(() => api.get(`/organisations/${o.id}/credentials`, { limit: 100 }), [o.id]);
  return (
    <Section title="Certificates & badges you issued" color={c.pink}>
      <T size={13} color={c.mute}>Issue one from an enquiry once the person is enrolled. They choose whether it shows on their profile; anyone can check a code.</T>
      {list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !list.data ? <Loading /> : list.data.length ? list.data.map((x) => (
        <Card key={x.id} pad={14}>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><T weight="700" style={{ flex: 1 }}>{x.title}</T><Tag label={x.status === 'issued' ? 'Valid' : 'Withdrawn'} /></View>
          <T size={12} color={c.mute}>{x.holder_name} (@{x.holder_handle}) · {x.kind}{x.programme_title ? ` · ${x.programme_title}` : ''} · code {x.code}</T>
          {x.status === 'issued' && !archived ? <Btn small title="Withdraw" color={c.paper} ink={c.red} style={{ alignSelf: 'flex-start', marginTop: 8 }} onPress={() => setRevoke(x)} /> : x.revoke_reason ? <T size={12} color={c.red}>{x.revoke_reason}</T> : null}
        </Card>
      )) : <Empty emoji="🎖️" title="Nothing issued yet" />}
      <FormSheet visible={!!revoke} onClose={() => setRevoke(null)} title="Withdraw this credential" submitLabel="Withdraw" fields={[{ key: 'reason', label: 'Reason (the holder is told)', type: 'multiline' }]}
        onSubmit={async (v) => { try { await api.post(`/credentials/${revoke.id}/revoke`, v); list.reload(); return 'Withdrawn'; } catch (e) { fail(toast)(e); throw e; } }} />
    </Section>
  );
}

function Listing({ o, archived, reload }) {
  const [edit, setEdit] = useState(false);
  const p = useLoad(() => api.get(`/organisations/${o.id}/institution`), [o.id]);
  if (p.error) return <ErrorBox error={p.error} onRetry={p.reload} />;
  if (!p.data) return <Loading />;
  const x = p.data;
  return (
    <Section title="Your public listing" color={c.violet}>
      <Card>
        <T weight="700">{x.listed ? 'Listed: athletes can find you' : 'Not listed: only your team can see this'}</T>
        {x.about ? <T style={{ marginTop: 6 }}>{x.about}</T> : <T color={c.mute} style={{ marginTop: 6 }}>No description yet.</T>}
        <T size={13} color={c.mute} style={{ marginTop: 6 }}>{[x.country, x.website, x.email, x.phone].filter(Boolean).join(' · ') || 'No contact route yet'}</T>
        <T size={11} color={c.mute} style={{ marginTop: 6 }}>Email and phone are stored encrypted and shown only to signed-in people who open your contact details.</T>
      </Card>
      {!archived ? <Btn small title="Edit listing" onPress={() => setEdit(true)} style={{ alignSelf: 'flex-start' }} /> : null}
      <FormSheet visible={edit} onClose={() => setEdit(false)} title="Your listing" submitLabel="Save" initial={{ about: x.about, country: x.country, website: x.website, contact_email: x.email, contact_phone: x.phone, listed: x.listed }}
        fields={[
          { key: 'about', label: 'About your institution', type: 'multiline', optional: true }, { key: 'country', label: 'Country', optional: true },
          { key: 'website', label: 'Website (https)', type: 'url', optional: true }, { key: 'contact_email', label: 'Admissions email', type: 'email', optional: true }, { key: 'contact_phone', label: 'Admissions phone', type: 'phone', optional: true },
          { key: 'listed', label: 'Show in the directory', type: 'switch', hint: 'Needs a website or an admissions email.' },
        ]}
        onSubmit={async (v) => { await api.patch(`/organisations/${o.id}/institution`, { about: v.about ?? null, country: v.country ?? null, website: v.website ?? null, contact_email: v.contact_email ?? null, contact_phone: v.contact_phone ?? null, listed: !!v.listed }); p.reload(); reload(); return 'Saved'; }} />
    </Section>
  );
}
