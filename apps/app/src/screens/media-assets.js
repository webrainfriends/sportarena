// Media rights (#482): governed media and clips. Every asset carries who owns it (declared, never assumed from the upload), what right it is released under,
// who may see it, where and on which platforms, when it publishes, lifts its embargo and expires, who appears in it with their consent, and what it was cut from.
// What each viewer sees is decided by the server on every request; this screen shows the live state it returns and the reason when something is held back.
import React, { useRef, useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { A, ABtn, ACard, AChip, AEmpty, ARow, ASection, AT, ReasonSheet } from '../arena';
import { ErrorBox, Loading, Sheet, T } from '../ui';
import { c } from '../theme';
import { FormSheet } from '../FormSheet';
import { countryName } from '../country-picker';
import { pickDocument } from './insurance';
import { openStored } from '../tender-ui';
import { RIGHT_OPTIONS, ASSET_KINDS, OWNER_KINDS, AUDIENCES, CONSENT_KINDS, TERRITORY, platformOptions, rightLabel, territoryText, fmtDT, nice, Facts, StateTag, Tags, LSection, LTag, LTags, LCard } from '../media-ui';

const STATE_HELP = {
  draft: 'Not published yet', scheduled: 'Publishes later', embargoed: 'Held under embargo', live: 'Live to its audience', expired: 'Past its expiry date', consent_lapsed: 'Hidden: guardian media consent is no longer current',
  withdrawn: 'Withdrawn', taken_down: 'Taken down', source_withdrawn: 'Hidden: the asset it was cut from was withdrawn',
};
const STATES = ['draft', 'scheduled', 'embargoed', 'live', 'expired', 'consent_lapsed', 'withdrawn', 'taken_down', 'source_withdrawn'];
const gameOptions = (games) => (games ?? []).slice(0, 40).map((g) => ({ value: g.id, label: `${g.home?.name ?? g.home_name ?? 'TBC'} v ${g.away?.name ?? g.away_name ?? 'TBC'} · ${fmtDT(g.scheduled_at)}` }));

export function AssetsPanel({ id, isOrg, games, partners = [] }) {
  const { toast } = useSession();
  const [state, setState] = useState(null);
  const d = useLoad(() => api.get(`/events/${id}/media/assets`, { state: state ?? undefined, limit: 100 }), [id, state]);
  const cols = useLoad(() => (isOrg ? api.get(`/events/${id}/media/collections`) : Promise.resolve([])), [id, isOrg]);
  const [form, setForm] = useState(false);
  const [open, setOpen] = useState(null);
  const [colForm, setColForm] = useState(false);
  const [colAssets, setColAssets] = useState(null);
  if (d.error) return <ErrorBox error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  const reload = () => { d.reload(); cols.reload(); };
  const items = d.data.items;
  return (
    <>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <AChip label="All" active={!state} onPress={() => setState(null)} />
        {(isOrg ? STATES : ['live', 'draft', 'embargoed']).map((s) => <AChip key={s} label={nice(s)} active={state === s} onPress={() => setState(s)} />)}
      </View>
      <ASection title="Media & clips" sub={isOrg ? 'Everything you have registered, with its live state' : 'Material you may use'} action="+ Register" onAction={() => setForm(true)} />
      {!items.length ? <AEmpty emoji="🎞️" title={state ? `Nothing ${nice(state)}` : 'No media yet'} sub={isOrg ? 'Register a clip, photo or recording with its rights, then publish it to the audience that may use it.' : 'Licensed media will appear here once it is released to you.'} action="Register media" onAction={() => setForm(true)} /> : items.map((a) => (
        <ARow key={a.id} onPress={() => setOpen(a.id)} left={<AT size={24}>{(ASSET_KINDS.find((k) => k.value === a.kind)?.label ?? '🎬').split(' ')[0]}</AT>}
          title={a.title} sub={[rightLabel(a.right_kind), a.credit, a.expires_at ? `expires ${fmtDT(a.expires_at)}` : null, a.state && a.state !== 'live' ? STATE_HELP[a.state] : null].filter(Boolean).join(' · ')}
          right={a.state ? <StateTag state={a.state} /> : <StateTag state="live" label="Available" />} />
      ))}
      {isOrg ? (
        <>
          <ASection title="Content collections" sub="Approved sets that a rights package can be scoped to" action="+ New" onAction={() => setColForm(true)} />
          {!(cols.data ?? []).length ? <AT size={13} color={A.mute}>No collections.</AT> : cols.data.map((k) => <ARow key={k.id} title={k.name} sub={`${k.assets} asset${k.assets === 1 ? '' : 's'}${k.archived_at ? ' · archived' : ''}`} right={<ABtn small title="Choose assets" tone="ghost" onPress={() => setColAssets(k)} />} />)}
        </>
      ) : null}
      <RegisterForm visible={form} onClose={() => setForm(false)} id={id} isOrg={isOrg} games={games} partners={partners} assets={items} onDone={(a) => { reload(); setOpen(a.id); }} />
      <FormSheet visible={colForm} onClose={() => setColForm(false)} title="New collection" fields={[{ key: 'name', label: 'Name' }, { key: 'description', label: 'What it holds', type: 'multiline', optional: true }]} submitLabel="Create"
        onSubmit={async (v) => { await api.post(`/events/${id}/media/collections`, v); cols.reload(); return 'Collection created'; }} />
      {colAssets ? <CollectionAssets collection={colAssets} assets={items} onClose={() => setColAssets(null)} onDone={reload} /> : null}
      {open ? <AssetSheet id={open} isOrg={isOrg} onClose={() => setOpen(null)} onChanged={reload} /> : null}
    </>
  );
}

function RegisterForm({ visible, onClose, id, isOrg, games, partners, assets, onDone }) {
  const fields = [
    { key: 'title', label: 'Title' },
    { key: 'kind', label: 'Kind', type: 'chips', options: ASSET_KINDS, default: 'clip' },
    { key: 'right_kind', label: 'Released under which right', type: 'chips', options: RIGHT_OPTIONS, default: 'highlights' },
    { key: 'external_url', label: 'Link to the hosted file (https)', optional: true, hint: 'Video and audio stay where they are hosted. For a photo or PDF leave this empty and upload it next.' },
    { key: 'fixture_id', label: 'Game it comes from', type: 'chips', optional: true, options: gameOptions(games) },
    { key: 'parent_asset_id', label: 'Cut from (source asset)', type: 'chips', optional: true, options: assets.slice(0, 30).map((a) => ({ value: a.id, label: a.title })), hint: 'Makes this a derivative: it disappears if the source is withdrawn' },
    { key: 'owner_kind', label: 'Who owns the rights', type: 'chips', options: isOrg ? OWNER_KINDS : OWNER_KINDS.filter((o) => o.value !== 'organiser'), default: isOrg ? 'organiser' : 'partner', hint: 'Declared by you. Uploading does not make anyone the owner.' },
    { key: 'owner_partner_id', label: 'Which partner', type: 'chips', show: (v) => v.owner_kind === 'partner', options: partners.map((p) => ({ value: p.partner_id, label: p.name })) },
    { key: 'owner_name', label: 'Owner / rights holder name', show: (v) => ['athlete', 'third_party'].includes(v.owner_kind) },
    { key: 'credit', label: 'Credit line', optional: true, hint: 'Shown publicly, e.g. "Photo: Official photographer"' },
    { key: 'caption', label: 'Caption', type: 'multiline', optional: true, hint: 'Public captions should not name young people' },
    { key: 'audience', label: 'Who may see it', type: 'chips', options: AUDIENCES, default: 'private' },
    { key: 'territory_mode', label: 'Territory', type: 'chips', options: TERRITORY, default: 'worldwide' },
    { key: 'countries', label: 'Countries', type: 'countries', optional: true, show: (v) => v.territory_mode !== 'worldwide' },
    { key: 'platforms', label: 'Platforms', type: 'multi', optional: true, options: platformOptions() },
    { key: 'publish_at', label: 'Publish at', type: 'datetime', optional: true },
    { key: 'embargo_until', label: 'Embargo lifts', type: 'datetime', optional: true },
    { key: 'expires_at', label: 'Expires', type: 'datetime', optional: true },
  ];
  return (
    <FormSheet visible={visible} onClose={onClose} title="Register media" fields={fields} submitLabel="Register as draft"
      onSubmit={async (v) => { const a = await api.post(`/events/${id}/media/assets`, { ...v, platforms: v.platforms ?? [], countries: v.territory_mode === 'worldwide' ? [] : v.countries ?? [] }); onDone(a); return 'Registered as a draft. Add the people in it, then publish.'; }} />
  );
}

function CollectionAssets({ collection, assets, onClose, onDone }) {
  const { toast } = useSession();
  const [pick, setPick] = useState([]);
  return (
    <Sheet visible onClose={onClose} title={`Add to ${collection.name}`}>
      <T size={13} color="#64748B">Choose assets of this event to add. Taking one out later keeps it in the library.</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{assets.map((a) => <AChip key={a.id} label={`${pick.includes(a.id) ? '✓ ' : ''}${a.title}`} active={pick.includes(a.id)} onPress={() => setPick(pick.includes(a.id) ? pick.filter((x) => x !== a.id) : [...pick, a.id])} />)}</View>
      <ABtn title={`Add ${pick.length || ''} to collection`} disabled={!pick.length} onPress={async () => { try { await api.post(`/media/collections/${collection.id}/assets`, { add: pick }); toast('Added'); onDone(); onClose(); } catch (x) { toast(x.message); } }} />
    </Sheet>
  );
}

/** One asset: rights, live state and why, the people in it with live consent, derivatives, history, and the actions the viewer may take. */
function AssetSheet({ id, isOrg, onClose, onChanged }) {
  const { toast } = useSession();
  const d = useLoad(() => api.get(`/media/assets/${id}`), [id]);
  const [form, setForm] = useState(null);
  const [ask, setAsk] = useState(null);
  const a = d.data;
  const reload = () => { d.reload(); onChanged?.(); };
  const act = async (action, reason) => { try { await api.post(`/media/assets/${id}/status`, { action, reason: reason || undefined, row_version: a.row_version }); toast({ publish: 'Published', withdraw: 'Withdrawn', take_down: 'Taken down', restore: 'Back to draft' }[action]); reload(); } catch (x) { toast(x.details?.code === 'guardian_consent_required' ? 'A young person in this needs current guardian media consent before it can be published' : x.details?.code === 'file_required' ? 'Upload the file first' : x.message); } };
  const upload = async () => { try { const f = await pickDocument(); if (!f) return; await api.upload(`/media/assets/${id}/file`, f.blob, { name: f.name }); toast('File stored securely'); reload(); } catch (x) { toast(x.message); } };
  const open = async () => { try { if (a.link?.startsWith('http')) { const { Linking } = await import('react-native'); await Linking.openURL(a.link); } else await openStored(a.link, a.title); } catch (x) { toast(x.message); } };
  const rows = a?.can ? [['State', a.state ? STATE_HELP[a.state] : null], ['Status', nice(a.status)], ['Why', a.status_reason], ['Right', rightLabel(a.right_kind)], ['Owner', a.owner_kind === 'partner' ? 'A media partner' : a.owner_name ? `${nice(a.owner_kind)}: ${a.owner_name}` : nice(a.owner_kind)], ['Audience', nice(a.audience)], ['Territory', territoryText(a, countryName)],
    ['Platforms', a.platforms?.length ? a.platforms.map(nice).join(', ') : 'Any'], ['Publishes', a.publish_at ? fmtDT(a.publish_at) : null], ['Embargo lifts', a.embargo_until ? fmtDT(a.embargo_until) : null], ['Expires', a.expires_at ? fmtDT(a.expires_at) : null], ['Credit', a.credit], ['Caption', a.caption]] : [];
  return (
    <Sheet visible onClose={onClose} title={a?.title ?? 'Media'}>
      {d.error ? <ErrorBox error={d.error} onRetry={d.reload} /> : !a ? <Loading /> : (
        <>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>{a.state ? <LTag state={a.state} /> : <LTag state="live" label="Available" />}{a.parent_asset_id ? <LTag state="scheduled" label="Derivative" /> : null}{a.file_pending ? <LTag state="attention" label="File needed" /> : null}</View>
          {a.can ? <Facts rows={rows} /> : <Facts rows={[['Right', rightLabel(a.right_kind)], ['Credit', a.credit], ['Caption', a.caption], ['Platforms', a.platforms?.length ? a.platforms.map(nice).join(', ') : null], ['Expires', a.expires_at ? fmtDT(a.expires_at) : null]]} />}
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            {a.link ? <ABtn small title="Open" tone="neon" onPress={open} /> : null}
            {a.can?.act && a.file_pending ? <ABtn small title="Upload file" tone="lime" onPress={upload} /> : null}
            {a.can?.act && a.status === 'draft' ? <ABtn small title="Publish" tone="lime" onPress={() => act('publish')} /> : null}
            {a.can?.act && a.status === 'published' ? <ABtn small title="Withdraw" tone="sun" onPress={() => setAsk('withdraw')} /> : null}
            {a.can?.take_down && !['taken_down'].includes(a.status) ? <ABtn small title="Take down" tone="live" onPress={() => setAsk('take_down')} /> : null}
            {a.can?.take_down && ['withdrawn', 'taken_down'].includes(a.status) ? <ABtn small title="Restore to draft" tone="ghost" onPress={() => act('restore')} /> : null}
            <ABtn small title="Check rights" tone="ghost" onPress={() => setForm('check')} />
            {a.can?.act && !['withdrawn', 'taken_down'].includes(a.status) ? <ABtn small title="Edit rights" tone="ghost" onPress={() => setForm('rights')} /> : null}
            {a.can?.act && !['withdrawn', 'taken_down'].includes(a.status) ? <ABtn small title="+ Person in it" tone="ghost" onPress={() => setForm('person')} /> : null}
          </View>
          {a.subjects ? (
            <>
              <LSection title="People & teams in it" sub="Young people need current guardian media consent, checked every time it is viewed" />
              {!a.subjects.length ? <T size={13} color={c.mute}>Nobody recorded. Add anyone who can be identified.</T> : a.subjects.map((s) => (
                <ARow key={s.id} title={s.display_name ?? s.team_name} sub={`${nice(s.consent_kind)}${s.consent_ref ? ` · ${s.consent_ref}` : ''}`} right={s.user_id ? <LTag state={s.media_consent_ok ? 'verified' : 'consent_lapsed'} label={s.media_consent_ok ? 'Consent OK' : 'No current consent'} /> : null} />
              ))}
            </>
          ) : null}
          {a.derivatives?.length ? <><LSection title="Clips cut from it" />{a.derivatives.map((x) => <T key={x.id} size={13} color={c.mute}>{x.title} · {nice(x.status)}</T>)}</> : null}
          {a.history ? <><LSection title="History" /><LCard>{a.history.map((h, i) => <T key={i} size={12.5} color={c.mute}>{fmtDT(h.at)} · <T size={12.5} weight="800">{nice(h.action)}</T>{h.actor_name ? ` · ${h.actor_name}` : ''}{h.detail?.reason ? ` · ${h.detail.reason}` : ''}</T>)}</LCard></> : null}
          {form === 'check' ? <RightsCheck asset={a} onClose={() => { setForm(null); reload(); }} /> : null}
          <ReasonSheet visible={!!ask} onClose={() => setAsk(null)} title={ask === 'take_down' ? 'Take this down' : 'Withdraw this'} sub={ask === 'take_down' ? 'It disappears at once for everyone, along with every clip cut from it. Nothing is deleted: the file and history are kept for retention and contract purposes.' : 'It is hidden from its audience. Nothing is deleted.'}
            presets={ask === 'take_down' ? ['Rights dispute', 'Safeguarding', 'Legal request', 'Wrong content'] : ['Superseded', 'Licence ended', 'Error']} confirmLabel={ask === 'take_down' ? 'Take down' : 'Withdraw'} tone="live" onConfirm={async (reason) => { await act(ask, reason); }} />
          <FormSheet visible={form === 'rights'} onClose={() => setForm(null)} title="Edit rights"
            fields={[{ key: 'title', label: 'Title' }, { key: 'credit', label: 'Credit line', optional: true }, { key: 'caption', label: 'Caption', type: 'multiline', optional: true }, { key: 'right_kind', label: 'Right', type: 'chips', options: RIGHT_OPTIONS }, { key: 'audience', label: 'Who may see it', type: 'chips', options: AUDIENCES },
              { key: 'territory_mode', label: 'Territory', type: 'chips', options: TERRITORY }, { key: 'countries', label: 'Countries', type: 'countries', optional: true, show: (v) => v.territory_mode !== 'worldwide' }, { key: 'platforms', label: 'Platforms', type: 'multi', optional: true, options: platformOptions() },
              { key: 'publish_at', label: 'Publish at', type: 'datetime', optional: true }, { key: 'embargo_until', label: 'Embargo lifts', type: 'datetime', optional: true }, { key: 'expires_at', label: 'Expires', type: 'datetime', optional: true }]}
            initial={{ title: a.title, credit: a.credit ?? undefined, caption: a.caption ?? undefined, right_kind: a.right_kind, audience: a.audience, territory_mode: a.territory_mode, countries: a.countries, platforms: a.platforms, publish_at: a.publish_at ?? undefined, embargo_until: a.embargo_until ?? undefined, expires_at: a.expires_at ?? undefined }}
            submitLabel="Save rights" onSubmit={async (v) => { await api.post(`/media/assets/${id}/rights`, { ...v, row_version: a.row_version, platforms: v.platforms ?? [], countries: v.territory_mode === 'worldwide' ? [] : v.countries ?? [] }); reload(); return 'Rights saved'; }} />
          <FormSheet visible={form === 'person'} onClose={() => setForm(null)} title="Someone who appears in it"
            fields={[{ key: 'user_id', label: 'Person', type: 'entity', entityKind: 'person', noun: 'person' }, { key: 'consent_kind', label: 'Consent they rely on', type: 'chips', options: CONSENT_KINDS, default: 'athlete_release' }, { key: 'consent_ref', label: 'Reference', optional: true, hint: 'Form number, agreement or release reference' }]}
            submitLabel="Add" onSubmit={async (v) => {
              const keep = a.subjects.map((s) => ({ user_id: s.user_id ?? undefined, team_id: s.team_id ?? undefined, consent_kind: s.consent_kind, consent_ref: s.consent_ref ?? undefined }));
              await api.post(`/media/assets/${id}/rights`, { row_version: a.row_version, subjects: [...keep, v] }); reload(); return 'Added';
            }} />
        </>
      )}
    </Sheet>
  );
}

/** Ask the server whether this asset may be published, exported or handed to a partner, for a platform and country. Every rule is shown with its answer, and the check is kept in the audit log. */
function RightsCheck({ asset, onClose }) {
  const [res, setRes] = useState(null);
  const sent = useRef(false);
  const lic = useLoad(() => (asset.can?.act ? api.get(`/events/${asset.event_id}/media/licences`, { stage: 'active', limit: 100 }) : Promise.resolve([])), [asset.id]);
  const purposes = [...(asset.can?.act && asset.status === 'draft' ? [{ value: 'publish', label: '🚀 Publish it' }] : []), { value: 'export', label: '📤 Export or share it' }, ...(asset.can?.act ? [{ value: 'distribute', label: '🤝 Hand it to a partner' }] : [])];
  if (res) {
    return (
      <Sheet visible onClose={onClose} title={res.outcome === 'allowed' ? '✅ Allowed' : '⛔ Blocked'}>
        <T size={13} color={c.mute}>{res.outcome === 'allowed' ? 'Every rule passed. This check is kept in the audit log.' : 'At least one rule failed. Nothing was released, and this check is kept in the audit log.'}</T>
        {res.rules.map((r) => (
          <ARow key={r.rule} left={<AT size={20}>{r.ok ? '✅' : '⛔'}</AT>} title={r.label} sub={r.ok ? null : r.detail} />
        ))}
        {res.provenance ? <Facts rows={[['Owner', res.provenance.owner_name ?? nice(res.provenance.owner_kind)], ['Credit', res.provenance.credit], ['Cut from', res.provenance.cut_from?.length ? res.provenance.cut_from.map((x) => x.title).join(' ← ') : null]]} /> : null}
        <ABtn title="Done" tone="ghost" onPress={onClose} />
      </Sheet>
    );
  }
  return (
    <FormSheet visible onClose={() => { if (!sent.current) onClose(); }} title="Check rights" submitLabel="Check"
      fields={[
        { key: 'purpose', label: 'What do you want to do with it?', type: 'chips', options: purposes, default: purposes[0].value },
        { key: 'licence_id', label: 'Under which partner licence', type: 'choice', show: (v) => v.purpose === 'distribute', options: (lic.data ?? []).filter((l) => l.in_force).map((l) => ({ value: l.id, label: `${l.partner_name} · ${l.licence_no}` })), hint: 'The asset is judged against this licence: rights, platforms, territory, scope and delay.' },
        { key: 'platform', label: 'Platform', type: 'chips', optional: true, options: platformOptions(), show: (v) => v.purpose !== 'publish' },
        { key: 'country', label: 'Country it will be used in', type: 'country', optional: true, show: (v) => v.purpose !== 'publish' },
      ]}
      onSubmit={async (v) => { const r = await api.post(`/media/assets/${asset.id}/rights-check`, v); sent.current = true; setRes(r); return null; }} />
  );
}

/** The audit trail of rights checks for an event (organiser): who asked, for what, the answer and what failed. */
export function RightsLog({ id }) {
  const d = useLoad(() => api.get(`/events/${id}/media/rights-checks`, { limit: 20 }), [id]);
  if (d.error) return <ErrorBox error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  return (
    <>
      <ASection title="Rights check log" sub="Every check before publishing, exporting or handing content over. It cannot be edited." />
      {!d.data.items.length ? <AEmpty emoji="🧾" title="No checks yet" sub="Checks appear here when anyone publishes media, checks its rights, or takes a licensed file." /> : d.data.items.map((k) => (
        <ARow key={k.id} left={<AT size={22}>{k.outcome === 'allowed' ? '✅' : '⛔'}</AT>} title={`${nice(k.purpose)} · ${k.asset_title}`}
          sub={[k.checked_by, fmtDT(k.checked_at), k.licence_no, k.country, k.platform ? nice(k.platform) : null, k.failed?.length ? `failed: ${k.failed.map(nice).join(', ')}` : null].filter(Boolean).join(' · ')}
          right={<StateTag state={k.outcome} />} />
      ))}
    </>
  );
}
