// Event accreditation (#481): one home for it, inside the event console. Everyone sees their own accreditation and what they can apply for;
// the organiser, department leads and team managers also get the approval queue, issued credentials, nominations and (organiser) the scheme.
// The holder's pass with its QR (MyAccreditations) and the gate scanner (GateScan) live here too. All logic is in the API; this only calls it.
import React, { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, TextInput, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { useSession } from '../session';
import { useDo } from './console-utils';
import { A, AAvatar, ABar, ABtn, ACard, AChip, AEmpty, ARow, ASection, AStat, AT, ATag, ReasonSheet } from '../arena';
import { FormSheet } from '../FormSheet';
import { EntityPicker } from '../entity-picker';
import { Btn, Card, Chip, Empty, ErrorBox, GradCard, Loading, Screen, Sheet, T } from '../ui';
import { c } from '../theme';
import { locale } from '../locale';
import { QrCode } from './passport';

const stamp = (d) => (d ? new Date(d).toLocaleString(locale, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : null);
const midnight = (d) => d.getHours() === 0 && d.getMinutes() === 0;
const dateOnly = (d) => d.toLocaleDateString(locale, { day: 'numeric', month: 'short' });
/** Validity as people read it: whole days when the window runs midnight to midnight ("26 Oct → 29 Oct"), else with times. */
const span = (a) => {
  if (!a.valid_from && !a.valid_to) return 'Whole event';
  const from = a.valid_from ? new Date(a.valid_from) : null, to = a.valid_to ? new Date(a.valid_to) : null;
  if ((!from || midnight(from)) && (!to || midnight(to))) return [from && dateOnly(from), to && dateOnly(new Date(to.getTime() - 1))].filter(Boolean).join(' → ');
  return [stamp(a.valid_from), stamp(a.valid_to)].filter(Boolean).join(' → ');
};
const STATUS_TONE = { approved: A.green, submitted: A.sun, under_review: A.cyan, draft: A.mute, rejected: A.red, revoked: A.red, withdrawn: A.mute, suspended: A.orange, expired: A.mute, not_yet_valid: A.sun };
const STATUS_LABEL = { approved: 'Approved', submitted: 'Waiting', under_review: 'In review', draft: 'Draft', rejected: 'Rejected', revoked: 'Revoked', withdrawn: 'Withdrawn', suspended: 'Suspended', expired: 'Expired', not_yet_valid: 'Starts soon' };
const ORIGIN = { self: 'Applied', nomination: 'Nominated', invitation: 'Invited' };
const APPROVAL = [['organiser', 'Organiser approves'], ['department_lead', 'Department lead approves'], ['auto', 'Automatic when eligible']];
const VERIFY = [['', 'None'], ['gamer', 'Verified athlete'], ['coach', 'Verified coach'], ['physio', 'Verified physio'], ['doctor', 'Verified doctor']];
const COLOURS = [['#8B5CF6', 'Violet'], ['#06B6D4', 'Cyan'], ['#34D399', 'Green'], ['#FBBF24', 'Gold'], ['#FB923C', 'Orange'], ['#F43F5E', 'Red'], ['#9B72C6', 'Orchid']];
const deviceZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; } };
const localIso = (day, end) => new Date(`${day}T${end ? '23:59:59' : '00:00:00'}`).toISOString();
const dayOf = (iso) => (iso ? new Date(iso).toLocaleDateString('en-CA') : undefined);

// ---- the holder's pass ----------------------------------------------------------------------------------------------------------------------------

const DEAD = { rejected: 'Not approved', revoked: 'Revoked', withdrawn: 'Withdrawn', suspended: 'Suspended at the gate', expired: 'Expired', not_yet_valid: 'Not valid yet' };

/** The badge: category colour, who and where, the QR. A badge that does not admit anyone shows why instead of a code. */
export function Pass({ a, onChanged }) {
  const { toast } = useSession();
  const [replace, setReplace] = useState(false);
  const live = a.credential?.active;
  const dead = DEAD[a.effective_status];
  const reissue = async (reason) => {
    try { await api.post(`/accreditations/${a.id}/reissue`, { credential_version: a.credential.version, reason }); toast('New code issued. The old one no longer works.'); setReplace(false); onChanged?.(); }
    catch (x) { toast('' + x.message); }
  };
  return (
    <GradCard colors={[a.colour, '#2A2D3A']} pad={20} style={{ gap: 12 }}>
      <T size={11} weight="800" color="rgba(255,255,255,0.85)" style={{ letterSpacing: 1.6 }}>{String(a.event).toUpperCase()}</T>
      <T size={30} weight="800" color="#fff" style={{ lineHeight: 34 }}>{a.category}</T>
      <T size={15} weight="700" color="#fff">{a.display_name}</T>
      {live ? (
        <View style={{ alignItems: 'center', gap: 8, marginVertical: 4 }}>
          <QrCode value={a.credential.token} size={Platform.OS === 'web' ? 220 : 240} label={`Accreditation QR code for ${a.category}`} />
          <T size={13} weight="800" color="#fff" style={{ letterSpacing: 1.5 }}>{a.credential.credential_id}</T>
        </View>
      ) : a.status === 'approved' || dead ? (
        <View style={{ borderRadius: 16, backgroundColor: 'rgba(0,0,0,0.35)', padding: 18, alignItems: 'center' }}>
          <T size={20} weight="800" color="#fff">{dead ?? STATUS_LABEL[a.effective_status]}</T>
          <T size={13} color="rgba(255,255,255,0.8)" style={{ textAlign: 'center', marginTop: 4 }}>{a.status === 'approved' ? 'This code does not admit anyone right now. Ask the organiser.' : a.reason ? `Reason: ${a.reason}` : 'No code was issued.'}</T>
        </View>
      ) : (
        <T size={14} color="rgba(255,255,255,0.9)">Your code appears here as soon as the organiser approves it.</T>
      )}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {(a.zones ?? []).map((z) => <View key={z.id} style={chip}><T size={12} weight="800" color="#fff">{z.name}</T></View>)}
        {a.escort_required ? <View style={[chip, { backgroundColor: c.sun }]}><T size={12} weight="800" color="#2A2D3A">Escort required</T></View> : null}
        {a.vehicle_access ? <View style={chip}><T size={12} weight="800" color="#fff">Vehicle access</T></View> : null}
        {a.equipment_access ? <View style={chip}><T size={12} weight="800" color="#fff">Equipment</T></View> : null}
      </View>
      <T size={12} color="rgba(255,255,255,0.8)">Valid {span(a)}</T>
      {live ? <Btn small title="Lost or damaged? Get a new code" color="rgba(255,255,255,0.18)" onPress={() => setReplace(true)} accessibilityLabel="Replace this credential" /> : null}
      <Sheet visible={replace} onClose={() => setReplace(false)} title="Replace this code">
        <T size={14} color={c.mute}>The old QR code stops working straight away and a new one appears here. Gate staff are not told why.</T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {[['lost', 'I lost it'], ['stolen', 'It was stolen'], ['damaged', 'It is damaged']].map(([k, l]) => <Chip key={k} label={l} onPress={() => reissue(k)} />)}
        </View>
      </Sheet>
    </GradCard>
  );
}
const chip = { borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: 'rgba(255,255,255,0.2)' };

export function MyAccreditations() {
  const { push } = useNav();
  const mine = useLoad(() => api.get('/me/accreditations', { limit: 100 }), []);
  const rows = mine.data ?? [];
  const live = rows.filter((a) => !['rejected', 'withdrawn', 'revoked'].includes(a.status));
  return (
    <Screen>
      {mine.error ? <ErrorBox error={mine.error} onRetry={mine.reload} /> : !mine.data ? <Loading /> : live.length ? live.map((a) => (
        <View key={a.id} style={{ gap: 8 }}>
          <Pass a={a} onChanged={mine.reload} />
          <Btn small title="Event accreditation" color={c.paper} ink={c.ink} onPress={() => push('EventCommand', { id: a.event_id, tab: 'accreditation' })} style={{ alignSelf: 'flex-start' }} />
        </View>
      )) : <Empty emoji="🎫" title="No accreditation yet" sub="When an organiser nominates you, or you apply from an event's Accreditation tab, your badge shows up here with its QR code." />}
      {rows.length > live.length ? <T size={12} color={c.mute} style={{ textAlign: 'center' }}>{rows.length - live.length} closed application{rows.length - live.length === 1 ? '' : 's'} hidden (rejected, withdrawn or revoked).</T> : null}
    </Screen>
  );
}

// ---- the tab ------------------------------------------------------------------------------------------------------------------------------------

export function AccreditationTab({ id, e, isOrg }) {
  const { push } = useNav();
  const [sub, setSub] = useState(null);
  const kinds = useLoad(() => api.get('/accreditation-kinds'), []);
  const cats = useLoad(() => api.get(`/events/${id}/accreditation/categories`), [id]);
  const mine = useLoad(() => api.get('/me/accreditations', { limit: 100 }), [id]);
  const list = useLoad(() => api.get(`/events/${id}/accreditations`, { limit: 100 }).catch(() => null), [id]);
  const report = useLoad(() => api.get(`/events/${id}/accreditation/report`).catch(() => null), [id]);
  const zones = useLoad(() => (isOrg ? api.get(`/events/${id}/accreditation/zones`, { archived: true }) : Promise.resolve([])), [id, isOrg]);
  const venues = useLoad(() => (isOrg ? api.get(`/events/${id}/venues`).catch(() => []) : Promise.resolve([])), [id, isOrg]);
  const sites = [{ value: '', label: 'Any site' }, ...(venues.data ?? []).map((v) => ({ value: v.venue_id ?? v.id, label: v.name }))];
  const [badge, setBadge] = useState(null), [nominate, setNominate] = useState(false), [catForm, setCatForm] = useState(null), [zoneForm, setZoneForm] = useState(false);
  const reload = () => { cats.reload(); mine.reload(); list.reload(); report.reload(); zones.reload(); };
  const act = useDo(reload);
  const manage = isOrg || !!list.data;
  const gate = !!report.data;
  const here = (mine.data ?? []).filter((a) => a.event_id === id && a.status !== 'draft');
  const open = (cats.data ?? []).filter((k) => k.can_apply);
  const T0 = report.data?.totals;

  const mineBlock = (
    <>
      <ASection title="My accreditation" sub={here.length ? undefined : 'Your badge for this event'} />
      {here.map((a) => (
        <ARow key={a.id} onPress={() => setBadge(a)} left={<View style={{ width: 8, alignSelf: 'stretch', borderRadius: 4, backgroundColor: a.colour }} />} title={a.category}
          sub={`${span(a)}${a.credential?.active ? ' · tap to show your QR' : ''}`} right={<ATag label={STATUS_LABEL[a.effective_status]} tone={STATUS_TONE[a.effective_status]} />} />
      ))}
      {open.map((k) => (
        <ARow key={k.id} left={<View style={{ width: 8, alignSelf: 'stretch', borderRadius: 4, backgroundColor: k.colour }} />} title={k.name} sub={`${(k.zones ?? []).map((z) => z.name).join(', ') || 'Event access'}${k.approval === 'auto' ? ' · approved instantly' : ''}`}
          right={<ABtn small title="Apply" tone="neon" onPress={() => act(() => api.post(`/accreditation/categories/${k.id}/apply`), 'Applied')} />} />
      ))}
      {!here.length && !open.length ? <AEmpty emoji="🎫" title="No accreditation for you" sub="If you work or play at this event, the organiser or your team manager nominates you, or categories open for applications show up here." /> : null}
      {(cats.data ?? []).filter((k) => !k.can_apply && !k.my_accreditation && k.self_apply && k.apply_blocked).length ? (
        <AT size={12} color={A.mute}>Other categories need a matching role at this event first.</AT>
      ) : null}
    </>
  );

  const tab = sub ?? (isOrg || gate ? 'overview' : 'queue');
  if (!manage) return <>{mineBlock}<Sheet visible={!!badge} onClose={() => setBadge(null)} title="Your badge">{badge ? <Pass a={mine.data?.find((x) => x.id === badge.id) ?? badge} onChanged={reload} /> : null}</Sheet></>;

  return (
    <>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        {isOrg || gate ? <AChip label="📊 Summary" active={tab === 'overview'} onPress={() => setSub('overview')} /> : null}
        <AChip label="📥 Applications" badge={T0?.outstanding_approvals || undefined} active={tab === 'queue'} onPress={() => setSub('queue')} />
        <AChip label="🎫 Badges" active={tab === 'badges'} onPress={() => setSub('badges')} />
        {isOrg ? <AChip label="🗺️ Scheme" active={tab === 'scheme'} onPress={() => setSub('scheme')} /> : null}
        <AChip label="🙋 Mine" active={tab === 'mine'} onPress={() => setSub('mine')} />
      </View>
      <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
        {(cats.data ?? []).some((k) => k.status === 'active') ? <ABtn small title="Nominate people" tone="neon" onPress={() => setNominate(true)} /> : null}
        {gate ? <ABtn small title="Open the gate scanner" tone="lime" onPress={() => push('GateScan', { id })} /> : null}
      </View>

      {tab === 'overview' ? (
        <>
          {T0 ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
              <AStat icon="📥" value={T0.outstanding_approvals} label="Waiting" tone={T0.outstanding_approvals ? A.sun : undefined} /><AStat icon="✅" value={T0.live} label="Live badges" tone={A.green} />
              <AStat icon="🚪" value={T0.checked_in} label="Checked in" /><AStat icon="💤" value={T0.never_used} label="Never used" /><AStat icon="⛔" value={T0.revoked + T0.suspended} label="Revoked / held" tone={T0.revoked ? A.red : undefined} /><AStat icon="⌛" value={T0.expired} label="Expired" />
            </View>
          ) : null}
          {report.data ? (
            <>
              <ASection title="By category" sub="Approved is a decision; live means it admits people now; checked in means it was scanned at a gate" />
              {report.data.categories.length ? report.data.categories.map((k) => (
                <ACard key={k.category_id} pad={14} style={{ gap: 8 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: k.colour }} /><AT size={15} weight="800" style={{ flex: 1 }}>{k.name}{k.status === 'archived' ? ' · archived' : ''}</AT><AT size={12} color={A.mute}>{k.capacity ? `${k.approved}/${k.capacity} places` : `${k.approved} approved`}</AT></View>
                  <ABar pct={k.approved ? (k.checked_in / k.approved) * 100 : 0} color={k.colour} />
                  <AT size={12} color={A.mute}>{k.waiting} waiting · {k.live} live · {k.checked_in} checked in{k.suspended ? ` · ${k.suspended} held` : ''}{k.revoked ? ` · ${k.revoked} revoked` : ''}{k.expired ? ` · ${k.expired} expired` : ''}</AT>
                </ACard>
              )) : <AEmpty emoji="🗺️" title="No categories yet" sub={isOrg ? 'Define who gets which access in the Scheme tab.' : undefined} action={isOrg ? 'Open the scheme' : undefined} onAction={() => setSub('scheme')} />}
              <ASection title="Zones" sub="Who is inside right now" />
              {report.data.zones.filter((z) => !z.archived).map((z) => (
                <ARow key={z.zone_id} title={z.name} sub={`${z.permitted} permitted · ${z.admitted} admitted · ${z.refused} refused`} right={<AT size={22} weight="900" num color={z.inside ? A.green : A.mute}>{z.inside}</AT>} />
              ))}
              <ARow title="Event gate" sub={`${report.data.site.admitted} admitted · ${report.data.site.refused} refused`} right={<AT size={22} weight="900" num color={report.data.site.inside ? A.green : A.mute}>{report.data.site.inside}</AT>} />
            </>
          ) : null}
        </>
      ) : null}
      {tab === 'mine' ? mineBlock : null}

      {tab === 'queue' ? <Queue rows={(list.data ?? []).filter((r) => ['submitted', 'under_review', 'draft'].includes(r.status))} act={act} /> : null}
      {tab === 'badges' ? <Badges rows={(list.data ?? []).filter((r) => !['submitted', 'under_review', 'draft'].includes(r.status))} act={act} /> : null}
      {tab === 'scheme' && isOrg ? (

        <>
          <ASection title="Zones" sub="Areas people can be admitted to" action="Add zone" onAction={() => setZoneForm(true)} />
          {(zones.data ?? []).length ? zones.data.map((z) => (
            <ARow key={z.id} title={`${z.name}${z.archived_at ? ' · archived' : ''}`} sub={[(kinds.data?.zone_kinds ?? []).find((k) => k.key === z.kind)?.label, z.venue].filter((x) => x && x !== z.name).join(' · ') || undefined}
              right={<ABtn small tone="ghost" title={z.archived_at ? 'Restore' : 'Archive'} onPress={() => act(() => api.patch(`/accreditation/zones/${z.id}`, { archived: !z.archived_at }), z.archived_at ? 'Restored' : 'Archived')} />} />
          )) : <AEmpty emoji="🚪" title="No zones yet" sub="Field of play, athlete area, locker room, media centre, mixed zone, hospitality, operations, loading area." action="Add a zone" onAction={() => setZoneForm(true)} />}
          <ASection title="Categories" sub="Who is eligible, where and when" action="Add category" onAction={() => setCatForm({})} />
          {(cats.data ?? []).length ? cats.data.map((k) => (
            <ACard key={k.id} pad={14} onPress={() => setCatForm(k)} style={{ gap: 6 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: k.colour }} /><AT size={15} weight="800" style={{ flex: 1 }}>{k.name}</AT>{k.status === 'archived' ? <ATag label="archived" /> : null}</View>
              <AT size={12.5} color={A.mute}>{k.eligible.map((x) => (kinds.data?.engagements ?? []).find((g) => g.key === x)?.label ?? x).join(', ')}</AT>
              <AT size={12.5} color={A.mute}>{(k.zones ?? []).map((z) => z.name).join(', ') || 'Event gate only'} · {APPROVAL.find(([v]) => v === k.approval)[1]}{k.self_apply ? ' · open to apply' : ''}{k.capacity ? ` · ${k.capacity} places` : ''}</AT>
            </ACard>
          )) : <AEmpty emoji="🏷️" title="No categories yet" sub="Create one per kind of badge: Athlete, Team staff, Official, Media, Vendor, VIP." action="Add a category" onAction={() => setCatForm({})} />}
        </>
      ) : null}

      <CategoryForm k={catForm} onClose={() => setCatForm(null)} id={id} kinds={kinds.data} sites={sites} zones={(zones.data ?? []).filter((z) => !z.archived_at)} onDone={reload} />
      <FormSheet visible={zoneForm} onClose={() => setZoneForm(false)} title="Add a zone" submitLabel="Add zone" initial={{ kind: 'custom', venue_id: '' }}
        fields={[{ key: 'name', label: 'Zone name' }, { key: 'kind', label: 'Kind of zone', type: 'chips', options: (kinds.data?.zone_kinds ?? []).map((k) => ({ value: k.key, label: k.label })) }, ...((venues.data ?? []).length > 1 ? [{ key: 'venue_id', label: 'Site', type: 'chips', options: sites, hint: 'Tie the zone to one venue of this multi-venue event.' }] : [])]}
        onSubmit={async (v) => { await api.post(`/events/${id}/accreditation/zones`, { name: v.name, kind: v.kind, venue_id: v.venue_id || undefined }); reload(); return null; }} />
      <NominateSheet visible={nominate} onClose={() => setNominate(false)} id={id} cats={(cats.data ?? []).filter((k) => k.status === 'active')} isOrg={isOrg} onDone={reload} />
      <Sheet visible={!!badge} onClose={() => setBadge(null)} title="Your badge">{badge ? <Pass a={mine.data?.find((x) => x.id === badge.id) ?? badge} onChanged={reload} /> : null}</Sheet>
    </>
  );
}

function Person({ r, right, sub }) {
  return <ARow left={<AAvatar user={r} size={40} />} title={r.display_name} sub={sub} right={right} />;
}

function Queue({ rows, act }) {
  const [reject, setReject] = useState(null);
  return (
    <>
      <ASection title="Applications" sub={`${rows.length} waiting for a decision`} />
      {rows.length ? rows.map((r) => (
        <ACard key={r.id} pad={12} style={{ gap: 10 }}>
          <Person r={r} sub={`${r.category} · ${ORIGIN[r.origin]}${r.youth ? ' · under 18' : ''}`} right={<ATag label={STATUS_LABEL[r.status]} tone={STATUS_TONE[r.status]} />} />
          {r.can_decide ? (
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              <ABtn small tone="lime" title="Approve & issue" onPress={() => act(() => api.post(`/accreditations/${r.id}/decision`, { decision: 'approve' }), 'Approved. Badge issued.')} />
              {r.status === 'submitted' ? <ABtn small tone="ghost" title="Start review" onPress={() => act(() => api.post(`/accreditations/${r.id}/decision`, { decision: 'review' }), 'In review')} /> : null}
              <ABtn small tone="ghost" title="Reject" onPress={() => setReject(r)} />
            </View>
          ) : r.status === 'draft' ? <ABtn small tone="neon" title="Submit" onPress={() => act(() => api.post(`/accreditations/${r.id}/submit`), 'Submitted')} /> : <AT size={12} color={A.mute}>Waiting for the organiser.</AT>}
        </ACard>
      )) : <AEmpty emoji="📥" title="Nothing waiting" sub="New applications and nominations land here." />}
      <ReasonSheet visible={!!reject} onClose={() => setReject(null)} title={`Reject ${reject?.display_name ?? ''}`} sub="They are told the reason." presets={['Not needed', 'Category full', 'Details incomplete', 'Not eligible']} confirmLabel="Reject"
        onConfirm={(reason) => act(() => api.post(`/accreditations/${reject.id}/decision`, { decision: 'reject', reason: reason.slice(0, 60) }), 'Rejected')} />
    </>
  );
}

function Badges({ rows, act }) {
  const [ask, setAsk] = useState(null); // { r, action }
  const [filter, setFilter] = useState('all');
  const shown = rows.filter((r) => filter === 'all' || r.effective_status === filter);
  return (
    <>
      <ASection title="Badges" sub={`${rows.length} on record`} />
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        {[['all', 'All'], ['approved', 'Live'], ['suspended', 'Held'], ['revoked', 'Revoked'], ['expired', 'Expired'], ['rejected', 'Rejected']].map(([k, l]) => <AChip key={k} label={l} active={filter === k} onPress={() => setFilter(k)} />)}
      </View>
      {shown.length ? shown.map((r) => (
        <ACard key={r.id} pad={12} style={{ gap: 10 }}>
          <Person r={r} sub={`${r.category} · ${r.serial ?? 'no code'} · v${r.credential_version || 0}`} right={<ATag label={STATUS_LABEL[r.effective_status]} tone={STATUS_TONE[r.effective_status]} />} />
          {r.can_decide && r.status === 'approved' ? (
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              {r.access === 'active' ? <ABtn small tone="sun" title="Suspend" onPress={() => setAsk({ r, action: 'suspend' })} /> : <ABtn small tone="lime" title="Restore" onPress={() => act(() => api.post(`/accreditations/${r.id}/access`, { action: 'restore' }), 'Restored')} />}
              <ABtn small tone="ghost" title="Replace code" onPress={() => setAsk({ r, action: 'reissue' })} />
              <ABtn small tone="live" title="Revoke" onPress={() => setAsk({ r, action: 'revoke' })} />
            </View>
          ) : null}
        </ACard>
      )) : <AEmpty emoji="🎫" title="No badges here" />}
      <ReasonSheet visible={!!ask} onClose={() => setAsk(null)} title={ask ? `${{ suspend: 'Suspend', revoke: 'Revoke', reissue: 'Replace the code of' }[ask.action]} ${ask.r.display_name}` : ''}
        sub={ask?.action === 'reissue' ? 'The old QR code stops working at once.' : ask?.action === 'revoke' ? 'Final. The badge stops working at every gate on the next scan and the holder is told.' : 'The badge stops working at every gate on the next scan. You can restore it.'}
        presets={ask?.action === 'reissue' ? ['lost', 'stolen', 'damaged', 'details_changed', 'security'] : ['Conduct', 'Role ended', 'Security', 'Issued in error']} confirmLabel="Confirm" tone={ask?.action === 'revoke' ? 'live' : 'sun'}
        onConfirm={(reason) => (ask.action === 'reissue'
          ? act(() => api.post(`/accreditations/${ask.r.id}/reissue`, { credential_version: ask.r.credential_version, reason: ['lost', 'stolen', 'damaged', 'details_changed', 'security'].includes(reason.split(':')[0]) ? reason.split(':')[0] : 'other' }), 'New code issued')
          : act(() => api.post(`/accreditations/${ask.r.id}/access`, { action: ask.action, reason: reason.slice(0, 60) }), ask.action === 'revoke' ? 'Revoked' : 'Suspended'))} />
    </>
  );
}

/** Nominate through the authority you hold: pick a category, then people from a team you manage, a department you lead, or (organiser) anyone. Eligibility is shown before you submit. */
function NominateSheet({ visible, onClose, id, cats, isOrg, onDone }) {
  const { toast } = useSession();
  const [cat, setCat] = useState(null), [pick, setPick] = useState({}), [anyone, setAnyone] = useState([]), [busy, setBusy] = useState(false), [draft, setDraft] = useState(false);
  const cands = useLoad(() => (visible && cat ? api.get(`/events/${id}/accreditation/candidates`, { category_id: cat }) : Promise.resolve(null)), [visible, cat]);
  useEffect(() => { if (visible) { setCat(null); setPick({}); setAnyone([]); setDraft(false); } }, [visible]);
  useEffect(() => { setPick({}); }, [cat]);
  const groups = cands.data?.groups ?? [];
  const send = async () => {
    setBusy(true);
    let added = 0; const skipped = [];
    try {
      for (const g of groups) {
        const ids = g.people.filter((p) => pick[`${g.team_id ?? g.department_id}:${p.user_id}`]).map((p) => p.user_id);
        if (!ids.length) continue;
        const r = await api.post(`/events/${id}/accreditation/nominations`, { category_id: cat, user_ids: ids, team_id: g.team_id, department_id: g.department_id, draft });
        added += r.added.length; skipped.push(...r.skipped);
      }
      if (anyone.length) { const r = await api.post(`/events/${id}/accreditation/nominations`, { category_id: cat, user_ids: anyone.map((p) => p.id), draft }); added += r.added.length; skipped.push(...r.skipped); }
      toast(`${added} ${draft ? 'saved as draft' : 'nominated'}${skipped.length ? ` · ${skipped.length} skipped: ${skipped[0].reason}` : ''}`); onDone(); onClose();
    } catch (x) { toast('' + x.message); } finally { setBusy(false); }
  };
  const count = Object.values(pick).filter(Boolean).length + anyone.length;
  return (
    <Sheet visible={visible} onClose={onClose} title="Nominate people">
      <T size={13} weight="800">Category</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{cats.map((k) => <Chip key={k.id} label={k.name} active={cat === k.id} onPress={() => setCat(k.id)} />)}</View>
      {cat ? (cands.loading ? <Loading /> : (
        <>
          {groups.map((g) => (
            <View key={`${g.kind}${g.team_id ?? g.department_id}`} style={{ gap: 6 }}>
              <T size={13} weight="800">{g.kind === 'team' ? `${g.emoji ?? '👥'} ${g.name}` : `🧩 ${g.name}`} · {g.people.filter((p) => p.eligible).length}/{g.people.length} eligible</T>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                {g.people.map((p) => {
                  const key = `${g.team_id ?? g.department_id}:${p.user_id}`;
                  return <Chip key={key} label={`${pick[key] ? '✓ ' : ''}${p.display_name}${p.has_application ? ' · already' : p.eligible ? '' : ' · not eligible'}`} active={!!pick[key]} onPress={() => (p.eligible ? setPick({ ...pick, [key]: !pick[key] }) : toast(p.has_application ? 'Already has an application' : p.reason))} />;
                })}
              </View>
              {g.people.some((p) => p.eligible) ? <Chip label="Select everyone eligible" onPress={() => setPick({ ...pick, ...Object.fromEntries(g.people.filter((p) => p.eligible).map((p) => [`${g.team_id ?? g.department_id}:${p.user_id}`, true])) })} /> : null}
            </View>
          ))}
          {!groups.length && !isOrg ? <Empty emoji="🧑‍🤝‍🧑" title="Nobody to nominate" sub="You can nominate players and staff of an accepted team you manage, or members of a department you lead." /> : null}
          {isOrg ? <AnyonePicker value={anyone} onChange={setAnyone} /> : null}
          <ABtn title={`${draft ? 'Save draft for' : 'Nominate'} ${count || ''}`.trim()} tone="hero" onPress={send} loading={busy} disabled={!count} />
          <Pressable onPress={() => setDraft(!draft)} accessibilityRole="switch" accessibilityState={{ checked: draft }} style={{ minHeight: 44, justifyContent: 'center' }}><T size={13} color={c.mute}>{draft ? '✓ ' : '○ '}Save as draft first (not submitted yet)</T></Pressable>
        </>
      )) : null}
    </Sheet>
  );
}

function AnyonePicker({ value, onChange }) {
  return <EntityPicker kind="person" multi label="Invite anyone else (guests, VIPs)" value={value} onChange={onChange} optional />;
}

function CategoryForm({ k, onClose, id, kinds, sites, zones, onDone }) {
  const edit = !!k?.id;
  const window = k?.valid_from || k?.valid_to ? 'dates' : 'event';
  const initial = edit ? {
    name: k.name, venue_id: k.venue_id ?? '', eligible: k.eligible, zone_ids: k.zone_ids ?? [], colour: k.colour, window, from: dayOf(k.valid_from), to: dayOf(k.valid_to), hours: !!k.daily_from, daily_from: k.daily_from?.slice(0, 5), daily_to: k.daily_to?.slice(0, 5),
    timezone: k.timezone, escort_required: k.escort_required, vehicle_access: k.vehicle_access, equipment_access: k.equipment_access, requires_photo: k.requires_photo, verify: k.requires_verification ?? '', approval: k.approval, self_apply: k.self_apply, limit: !!k.capacity, capacity: k.capacity ?? 50,
  } : { colour: '#8B5CF6', venue_id: '', window: 'event', hours: false, timezone: deviceZone(), approval: 'organiser', verify: '', eligible: [], zone_ids: [], limit: false, capacity: 50 };
  return (
    <FormSheet visible={!!k} onClose={onClose} title={edit ? 'Edit category' : 'Add a category'} submitLabel={edit ? 'Save' : 'Add category'} initial={initial}
      fields={[
        { key: 'name', label: 'Category name' },
        { key: 'colour', label: 'Badge colour', type: 'chips', options: COLOURS.map(([value, label]) => ({ value, label })) },
        { key: 's1', type: 'section', label: 'Who' },
        { key: 'eligible', label: 'Who is eligible', type: 'multi', options: (kinds?.engagements ?? []).map((g) => ({ value: g.key, label: g.label })), hint: 'Read live from their role at this event: entries and rosters, staff, vendors, departments.' },
        { key: 's2', type: 'section', label: 'Where' },
        { key: 'zone_ids', label: 'Zones it opens', type: 'multi', optional: true, options: zones.map((z) => ({ value: z.id, label: z.name })), hint: zones.length ? 'Leave empty for the event gate only.' : 'Add zones first in the Scheme tab.' },
        ...(sites.length > 2 ? [{ key: 'venue_id', label: 'Site', type: 'chips', options: sites }] : []),
        { key: 's3', type: 'section', label: 'When' },
        { key: 'window', label: 'Valid', type: 'chips', options: [{ value: 'event', label: 'Whole event' }, { value: 'dates', label: 'Specific dates' }] },
        { key: 'from', label: 'Dates', type: 'daterange', toKey: 'to', show: (v) => v.window === 'dates' },
        { key: 'hours', label: 'Only during set hours each day', type: 'switch' },
        { key: 'daily_from', label: 'From', type: 'time', show: (v) => v.hours }, { key: 'daily_to', label: 'Until', type: 'time', show: (v) => v.hours },
        { key: 'timezone', label: 'Time zone of those hours', type: 'timezone', show: (v) => v.hours },
        { key: 's4', type: 'section', label: 'Access' },
        { key: 'escort_required', label: 'Escort required', type: 'switch' }, { key: 'vehicle_access', label: 'Vehicle access', type: 'switch' }, { key: 'equipment_access', label: 'Equipment access', type: 'switch' },
        { key: 'requires_photo', label: 'Show their photo at the gate (never for under 18s)', type: 'switch' },
        { key: 's5', type: 'section', label: 'Approval' },
        { key: 'verify', label: 'Required verification', type: 'chips', options: VERIFY.map(([value, label]) => ({ value, label })) },
        { key: 'approval', label: 'Who approves', type: 'chips', options: APPROVAL.map(([value, label]) => ({ value, label })) },
        { key: 'self_apply', label: 'Eligible people can apply themselves', type: 'switch' },
        { key: 'limit', label: 'Limit the number of badges', type: 'switch' }, { key: 'capacity', label: 'Places', type: 'stepper', min: 1, max: 5000, show: (v) => v.limit },
      ]}
      onSubmit={async (v) => {
        const body = {
          name: v.name, colour: v.colour, venue_id: v.venue_id || null, eligible: v.eligible, zone_ids: v.zone_ids ?? [],
          valid_from: v.window === 'dates' && v.from ? localIso(v.from) : null, valid_to: v.window === 'dates' && (v.to || v.from) ? localIso(v.to || v.from, true) : null,
          daily_from: v.hours ? v.daily_from : null, daily_to: v.hours ? v.daily_to : null, timezone: v.timezone || deviceZone(),
          escort_required: !!v.escort_required, vehicle_access: !!v.vehicle_access, equipment_access: !!v.equipment_access, requires_photo: !!v.requires_photo,
          requires_verification: v.verify || null, approval: v.approval, self_apply: !!v.self_apply, capacity: v.limit ? v.capacity : null,
        };
        if (edit) await api.patch(`/accreditation/categories/${k.id}`, body); else await api.post(`/events/${id}/accreditation/categories`, body);
        onDone(); return null;
      }}
    />
  );
}

// ---- the gate -----------------------------------------------------------------------------------------------------------------------------------

const VERDICT = {
  valid: ['ADMIT', '#16A34A', 'Valid credential'],
  invalid: ['DENY', '#DC2626', 'Not a valid credential'],
  expired: ['EXPIRED', '#DC2626', 'This credential has expired'],
  not_yet_valid: ['NOT YET', '#D97706', 'Not valid yet'],
  revoked: ['REVOKED', '#DC2626', 'This credential was revoked. Hold the person and call a supervisor.'],
  suspended: ['SUSPENDED', '#D97706', 'Access is suspended. Refer to the organiser.'],
  replaced: ['REPLACED', '#D97706', 'An old code: the holder has a newer one'],
  wrong_event: ['WRONG EVENT', '#DC2626', 'This credential is for another event'],
  wrong_zone: ['WRONG ZONE', '#D97706', 'Not permitted in this zone'],
  outside_hours: ['OUTSIDE HOURS', '#D97706', 'Not permitted at this time of day'],
  not_eligible: ['DENY', '#DC2626', 'The role behind this credential has ended'],
};
let CameraMod = null;
try { CameraMod = require('expo-camera'); } catch { CameraMod = null; }

/** Camera reader: scans QR codes continuously; a code seen again within 3 seconds is ignored. */
function CameraScan({ onCode, onClose }) {
  const [perm, ask] = CameraMod.useCameraPermissions();
  const last = useRef({ code: null, at: 0 });
  useEffect(() => { if (perm && !perm.granted && perm.canAskAgain) ask(); }, [perm?.granted]);
  if (!perm?.granted) return <Card><T>Camera access is needed to scan. {perm?.canAskAgain === false ? 'Allow it in Settings, or type the code below.' : ''}</T><Btn small title="Allow camera" onPress={ask} style={{ marginTop: 8, alignSelf: 'flex-start' }} /></Card>;
  const { CameraView } = CameraMod;
  return (
    <View style={{ borderRadius: 24, overflow: 'hidden', height: 280, backgroundColor: '#000' }}>
      <CameraView style={{ flex: 1 }} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }} accessibilityLabel="Camera view for scanning a QR code"
        onBarcodeScanned={({ data }) => { const now = Date.now(); if (data === last.current.code && now - last.current.at < 3000) return; last.current = { code: data, at: now }; onCode(data); }} />
      <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close camera" style={{ position: 'absolute', top: 10, right: 10, minWidth: 44, minHeight: 44, borderRadius: 22, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center' }}><T color="#fff" weight="800">✕</T></Pressable>
    </View>
  );
}

const key = () => `gate-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export function GateScan({ id }) {
  const { toast } = useSession();
  const ev = useLoad(() => api.get(`/events/${id}`), [id]);
  const zones = useLoad(() => api.get(`/events/${id}/accreditation/zones`).catch(() => []), [id]);
  const report = useLoad(() => api.get(`/events/${id}/accreditation/report`), [id]);
  const [zone, setZone] = useState(null), [dir, setDir] = useState('in'), [code, setCode] = useState(''), [res, setRes] = useState(null), [busy, setBusy] = useState(false), [cam, setCam] = useState(false), [recent, setRecent] = useState([]);
  const input = useRef(null);
  const submit = async (token) => {
    const t = String(token ?? code).trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      const r = await api.post(`/events/${id}/accreditation/scan`, { token: t, zone_id: zone || undefined, direction: dir, idempotency_key: key() });
      setRes(r); setRecent((p) => [{ ...r, at: r.at ?? new Date().toISOString(), zone: zones.data?.find((z) => z.id === zone)?.name ?? 'Event gate' }, ...p].slice(0, 8)); setCode('');
      if (r.result === 'valid') report.reload();
    } catch (x) { toast('' + x.message); } finally { setBusy(false); setTimeout(() => input.current?.focus?.(), 50); }
  };
  if (report.error) return <Screen><ErrorBox error={report.error} onRetry={report.reload} /><T color={c.mute}>Only the organiser and accreditation or security staff can scan credentials.</T></Screen>;
  const v = res ? VERDICT[res.result] : null;
  const inside = zone ? report.data?.zones?.find((z) => z.zone_id === zone)?.inside : report.data?.site?.inside;
  return (
    <Screen>
      <T size={13} color={c.mute}>{ev.data?.name}</T>
      <T size={15} weight="800" style={{ marginTop: 4 }}>Where are you scanning?</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Chip label="Event gate" active={!zone} onPress={() => setZone(null)} />
        {(zones.data ?? []).map((z) => <Chip key={z.id} label={z.name} active={zone === z.id} onPress={() => setZone(z.id)} />)}
      </View>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
        <Chip label="➡️ Entering" active={dir === 'in'} onPress={() => setDir('in')} /><Chip label="⬅️ Leaving" active={dir === 'out'} onPress={() => setDir('out')} />
        <T size={13} color={c.mute} style={{ marginLeft: 'auto' }}>Inside now: <T size={15} weight="800">{inside ?? '–'}</T></T>
      </View>

      {cam && CameraMod ? <CameraScan onCode={submit} onClose={() => setCam(false)} /> : CameraMod ? <Btn title="📷 Scan with the camera" onPress={() => setCam(true)} /> : null}

      <View style={{ flexDirection: 'row', gap: 8 }}>
        <TextInput ref={input} value={code} onChangeText={setCode} onSubmitEditing={() => submit()} autoCapitalize="none" autoCorrect={false} autoFocus={Platform.OS === 'web'} returnKeyType="go" placeholder="Scan or paste the code"
          placeholderTextColor={c.mute} accessibilityLabel="Credential code. A hardware scanner types it here." style={{ flex: 1, minWidth: 0, minHeight: 52, borderRadius: 16, borderWidth: 1.5, borderColor: c.line, backgroundColor: c.paper, color: c.ink, paddingHorizontal: 14, fontSize: 16 }} />
        <Btn title="Check" onPress={() => submit()} loading={busy} disabled={!code.trim()} accessibilityLabel="Check this code" />
      </View>

      {v ? (
        <View accessibilityRole="alert" accessibilityLiveRegion="assertive" style={{ borderRadius: 28, backgroundColor: v[1], padding: 22, gap: 10 }}>
          <T size={34} weight="800" color="#fff" style={{ letterSpacing: 1 }}>{res.result === 'valid' ? '✓ ' : '✕ '}{v[0]}</T>
          {res.holder ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
              {res.holder.avatar_url ? <AAvatar user={res.holder} size={72} /> : null}
              <View style={{ flex: 1 }}>
                <T size={24} weight="800" color="#fff">{res.holder.display_name}</T>
                {res.category ? <View style={{ alignSelf: 'flex-start', marginTop: 6, borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.25)', paddingHorizontal: 12, paddingVertical: 4 }}><T size={14} weight="800" color="#fff">{res.category.name}</T></View> : null}
              </View>
            </View>
          ) : null}
          <T size={15} weight="700" color="#fff">{v[2]}</T>
          {res.result === 'valid' ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {(res.zones ?? []).map((z) => <View key={z.id} style={chip}><T size={13} weight="800" color="#fff">{z.name}</T></View>)}
              {res.escort_required ? <View style={[chip, { backgroundColor: '#FBBF24' }]}><T size={13} weight="800" color="#2A2D3A">ESCORT REQUIRED</T></View> : null}
              {res.vehicle_access ? <View style={chip}><T size={13} weight="800" color="#fff">Vehicle access</T></View> : null}
              {res.equipment_access ? <View style={chip}><T size={13} weight="800" color="#fff">Equipment</T></View> : null}
            </View>
          ) : null}
          {res.credential_id ? <T size={12} color="rgba(255,255,255,0.8)">{res.credential_id}{res.replayed ? ' · repeat of an earlier scan' : ''}</T> : null}
        </View>
      ) : null}

      {recent.length ? (
        <>
          <T size={13} weight="800" style={{ marginTop: 6 }}>Recent scans</T>
          {recent.map((r, i) => (
            <View key={`${r.scan_id ?? i}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 }}>
              <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: VERDICT[r.result]?.[1] }} />
              <T size={14} weight="700" style={{ flex: 1 }}>{r.holder?.display_name ?? 'Unknown code'} · {VERDICT[r.result]?.[0]}</T>
              <T size={12} color={c.mute}>{r.zone} · {stamp(r.at)}</T>
            </View>
          ))}
        </>
      ) : null}
    </Screen>
  );
}
