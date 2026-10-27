// Media rights (#482): defining a rights package, offering or applying for a licence, and the licence itself (terms, answers, records, feeds, deliverables, history).
// Used by the organiser (event console, Broadcast tab) and by the media partner (workspace). The server decides who may do what; the sheet shows only what the viewer can use.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { ABtn, ReasonSheet } from '../arena';
import { ErrorBox, Loading, Sheet, T } from '../ui';
import { c } from '../theme';
import { FormSheet } from '../FormSheet';
import { PaySheet } from '../PaySheet';
import { countryName } from '../country-picker';
import { RIGHT_OPTIONS, TERRITORY, SCOPES, SUBLICENSING, LANGUAGES, platformOptions, rightLabel, territoryText, money, fmtRange, fmtDT, fmtD, dayOf, spanIso, nice, Facts, LSection, LTag, LTags, LCard, LEmpty, DATASETS } from '../media-ui';

const today = () => dayOf(new Date().toISOString());
const names = (r) => (r.countries ?? []).map(countryName);
const explainErr = (x) => (x?.details?.code === 'exclusivity_conflict' ? `Exclusive rights already held by ${x.details.conflicts.map((k) => `${k.partner} (${k.licence_no})`).join(', ')}` : x?.details?.code === 'terms_outside_package' ? x.message : x?.message ?? String(x));

/** Fields that describe the terms of a licence. `pkg` limits what can be chosen to what the package offers. */
function termFields(pkg) {
  return [
    { key: 'approved_rights', label: 'Rights', type: 'multi', options: RIGHT_OPTIONS.filter((o) => (pkg.rights ?? pkg.package_rights ?? []).includes(o.value)) },
    { key: 'approved_platforms', label: 'Platforms', type: 'multi', optional: true, options: platformOptions(pkg.platforms ?? pkg.package_platforms), hint: 'None selected = every platform the package allows' },
    { key: 'territory_mode', label: 'Territory', type: 'chips', options: TERRITORY, default: 'worldwide' },
    { key: 'countries', label: 'Countries', type: 'countries', optional: true, show: (v) => v.territory_mode !== 'worldwide' },
    { key: 'effective_from', toKey: 'effective_to', label: 'Licence dates', type: 'daterange', min: today(), hint: 'Must sit inside the package window' },
    { key: 'currency', label: 'Currency', type: 'currency', default: 'USD' },
    { key: 'fee_minor', label: 'Rights fee', type: 'money', currency: (v) => v.currency ?? 'USD', optional: true },
    { key: 'negotiation_ref', label: 'Negotiation reference', optional: true, hint: 'Your own deal or ticket number' },
    { key: 'note', label: 'Note to the other side', type: 'multiline', optional: true },
  ];
}
const termsBody = (v) => {
  const { from, to } = spanIso(v.effective_from, v.effective_to);
  const { effective_from, effective_to, ...rest } = v;
  return { ...rest, approved_platforms: v.approved_platforms ?? [], countries: v.territory_mode === 'worldwide' ? [] : v.countries ?? [], effective_from: from, effective_to: to };
};
const termsInitial = (l) => ({ approved_rights: l.approved_rights, approved_platforms: l.approved_platforms, territory_mode: l.territory_mode, countries: l.countries, effective_from: dayOf(l.effective_from), effective_to: dayOf(l.effective_to), fee_minor: Number(l.fee_minor), currency: l.currency, negotiation_ref: l.negotiation_ref ?? undefined, note: l.note ?? undefined });

/** Create or change a rights package of a competition. */
export function PackageForm({ visible, onClose, eventId, games, collections, initial, onSaved }) {
  const { toast } = useSession();
  const fx = (games ?? []).filter((g) => !['completed', 'cancelled'].includes(g.status));
  const fields = [
    { key: 'name', label: 'Package name' },
    { key: 'scope_kind', label: 'What the rights cover', type: 'chips', options: SCOPES, default: 'event' },
    { key: 'fixture_id', label: 'Which game', type: 'chips', show: (v) => v.scope_kind === 'fixture', options: fx.map((g) => ({ value: g.id, label: `${g.home?.name ?? g.home_name ?? 'TBC'} v ${g.away?.name ?? g.away_name ?? 'TBC'} · ${fmtDT(g.scheduled_at)}` })), hint: fx.length ? undefined : 'Schedule games in the Games tab first' },
    { key: 'collection_id', label: 'Which collection', type: 'chips', show: (v) => v.scope_kind === 'collection', options: (collections ?? []).map((k) => ({ value: k.id, label: `${k.name} (${k.assets})` })), hint: collections?.length ? undefined : 'Create a collection in the Media section first' },
    { key: 'rights', label: 'Rights on offer', type: 'multi', options: RIGHT_OPTIONS },
    { key: 'exclusive', label: 'Exclusive', type: 'switch', default: false, hint: 'An exclusive right can be held by one partner for the same platforms, territory and dates' },
    { key: 'territory_mode', label: 'Territory', type: 'chips', options: TERRITORY, default: 'worldwide' },
    { key: 'countries', label: 'Countries', type: 'countries', optional: true, show: (v) => v.territory_mode !== 'worldwide' },
    { key: 'platforms', label: 'Platforms', type: 'multi', optional: true, options: platformOptions(), hint: 'None selected = every platform' },
    { key: 'languages', label: 'Languages', type: 'multi', optional: true, options: LANGUAGES },
    { key: 'valid_from', toKey: 'valid_to', label: 'Validity window', type: 'daterange', min: today() },
    { key: 'embargo_minutes', label: 'Delay after a game ends', type: 'stepper', min: 0, max: 10080, step: 15, suffix: ' min', default: 0, hint: 'Replay, highlights, clips and archive wait this long after full time' },
    { key: 'sublicensing', label: 'Sublicensing', type: 'chips', options: SUBLICENSING, default: 'none' },
    { key: 'content_scope', label: 'Content scope', type: 'multiline', optional: true, hint: 'What is and is not included, in plain words' },
  ];
  const init = initial ? { ...initial, exclusive: initial.exclusivity === 'exclusive', valid_from: dayOf(initial.valid_from), valid_to: dayOf(initial.valid_to) } : {};
  return (
    <FormSheet visible={visible} onClose={onClose} title={initial ? 'Change package' : 'New rights package'} fields={fields} initial={init} submitLabel={initial ? 'Save package' : 'Create package'}
      onSubmit={async (v) => {
        const { from, to } = spanIso(v.valid_from, v.valid_to);
        const { exclusive, valid_from, valid_to, ...rest } = v;
        await api.post(`/events/${eventId}/media/packages`, { ...rest, package_id: initial?.id, exclusivity: exclusive ? 'exclusive' : 'non_exclusive', valid_from: from, valid_to: to, platforms: v.platforms ?? [], languages: v.languages ?? [], countries: v.territory_mode === 'worldwide' ? [] : v.countries ?? [] }).catch((x) => { throw new Error(explainErr(x)); });
        onSaved(); return initial ? 'Package saved' : 'Package created. Open it to partners when it is ready.';
      }} />
  );
}

/** The organiser offers a package to a partner, or a partner applies for an open package (`partner` is then fixed). */
export function OfferForm({ visible, onClose, pkg, partner, onDone }) {
  const fields = [
    ...(partner ? [] : [{ key: 'partner_id', label: 'Media partner', type: 'entity', entityKind: 'partner', noun: 'media partner' }]),
    ...termFields(pkg).map((f) => (f.key === 'approved_rights' ? { ...f, default: pkg.rights } : f)),
  ];
  return (
    <FormSheet visible={visible} onClose={onClose} title={partner ? `Apply: ${pkg.name}` : `Offer: ${pkg.name}`} fields={fields} submitLabel={partner ? 'Send application' : 'Send offer'}
      initial={{ approved_rights: pkg.rights, territory_mode: pkg.territory_mode, countries: pkg.countries, effective_from: dayOf(pkg.valid_from) < today() ? today() : dayOf(pkg.valid_from), effective_to: dayOf(pkg.valid_to) }}
      onSubmit={async (v) => { await api.post(`/media/packages/${pkg.id}/licences`, { ...termsBody(v), partner_id: partner?.partner_id ?? v.partner_id }).catch((x) => { throw new Error(explainErr(x)); }); onDone(); return 'Sent. The other side will be asked to accept it.'; }} />
  );
}

/** Everything about one licence, for whichever side is looking. */
export function LicenceSheet({ id, onClose, onChanged }) {
  const { toast } = useSession();
  const d = useLoad(() => api.get(`/media/licences/${id}`), [id]);
  const [ask, setAsk] = useState(null);       // 'decline' | 'suspend' | 'terminate'
  const [form, setForm] = useState(null);     // 'revise' | 'records' | 'deliver' | 'feed' | 'renew' | 'measure'
  const [busy, setBusy] = useState(false);
  const l = d.data;
  const sideOrg = l ? (l.as.organiser ? l.event_org_id : l.partner_org_id) : null;
  const agreements = useLoad(() => (sideOrg ? api.get(`/organisations/${sideOrg}/agreements`, { limit: 100 }).catch(() => []) : Promise.resolve([])), [sideOrg]);
  const done = (msg) => { if (msg) toast(msg); d.reload(); onChanged?.(); };
  const run = async (fn, ok) => { setBusy(true); try { await fn(); done(ok); } catch (x) { toast(explainErr(x)); } finally { setBusy(false); } };
  const decide = (action, reason) => run(() => api.post(`/media/licences/${id}/decision`, { action, reason: reason || undefined, row_version: l.row_version }), action === 'accept' ? 'Licence active' : 'Done');
  return (
    <Sheet visible onClose={onClose} title={l ? l.licence_no : 'Licence'}>
      {d.error ? <ErrorBox error={d.error} onRetry={d.reload} /> : !l ? <Loading /> : (
        <>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <LTag state={l.stage_now} />{l.in_force ? <LTag state="live" label="In force now" /> : null}{l.exclusivity === 'exclusive' ? <LTag state="attention" label="Exclusive" /> : null}
          </View>
          <T size={18} weight="800">{l.partner_name}</T>
          <T size={13} color="#64748B">{l.event_name} · {l.package_name}</T>
          <LTags items={l.approved_rights.map(rightLabel)} />
          <Facts rows={[['Window', fmtRange(l.effective_from, l.effective_to)], ['Territory', territoryText(l, countryName)], ['Platforms', l.approved_platforms.length ? l.approved_platforms.map(nice).join(', ') : 'Every platform the package allows'],
            ['Fee', Number(l.fee_minor) ? `${money(l.fee_minor, l.currency)} (contracted)` : 'No fee'], ['Days left', l.in_force ? `${l.days_left}` : null], ['Negotiation ref', l.negotiation_ref], ['Contract ref', l.contract_ref], ['Agreement', l.agreement ? `${l.agreement.title} (${nice(l.agreement.status)})` : null],
            ['Delay after games', l.embargo_minutes ? `${l.embargo_minutes} min` : null], ['Sublicensing', nice(l.sublicensing)], ['Note', l.note], ['Decision note', l.decision_note]]} />

          {['proposed', 'negotiating'].includes(l.stage_now) ? (
            <View style={{ gap: 8 }}>
              <T size={13} color="#64748B">{l.can.respond ? 'This offer is waiting for your answer.' : `Waiting for the ${l.proposed_by_side === 'organiser' ? 'media partner' : 'organiser'} to answer.`}</T>
              <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                {l.can.respond ? <ABtn title="Accept" tone="lime" loading={busy} onPress={() => decide('accept')} /> : null}
                {l.as.can_act ? <ABtn title="Counter-propose" tone="neon" onPress={() => setForm('revise')} /> : null}
                {l.as.can_act ? <ABtn title={l.can.respond ? 'Decline' : 'Withdraw'} tone="ghost" onPress={() => setAsk('decline')} /> : null}
              </View>
            </View>
          ) : null}
          {l.as.organiser && l.stage_now === 'active' ? <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}><ABtn small title="Suspend" tone="sun" onPress={() => setAsk('suspend')} /><ABtn small title="Terminate" tone="ghost" onPress={() => setAsk('terminate')} /></View> : null}
          {l.as.organiser && l.stage_now === 'suspended' ? <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}><ABtn small title="Reinstate" tone="lime" loading={busy} onPress={() => decide('reinstate')} /><ABtn small title="Terminate" tone="ghost" onPress={() => setAsk('terminate')} /></View> : null}
          {!l.as.organiser && l.as.can_act && ['active', 'suspended'].includes(l.stage_now) ? <ABtn small title="End these rights" tone="ghost" onPress={() => setAsk('terminate')} style={{ alignSelf: 'flex-start' }} /> : null}
          {l.as.can_act && ['active', 'suspended', 'expired'].includes(l.stage_now) ? <ABtn small title="Start a renewal" tone="neon" onPress={() => setForm('renew')} style={{ alignSelf: 'flex-start' }} /> : null}
          {l.as.can_act && !['declined', 'terminated', 'expired'].includes(l.stage_now) ? <ABtn small title="Link contract records" tone="ghost" onPress={() => setForm('records')} style={{ alignSelf: 'flex-start' }} /> : null}

          <LSection title="Data feeds" sub={l.approved_rights.includes('data_feed') ? 'Official scores and results for licensed systems' : 'This licence has no data-feed right'} action={l.as.organiser && l.in_force && l.approved_rights.includes('data_feed') ? '+ Grant' : undefined} onAction={() => setForm('feed')} />
          {l.feeds.map((f) => <FeedCard key={f.id} f={f} l={l} onDone={done} toast={toast} />)}

          <LSection title="Fees" sub="What has been invoiced and collected against the contracted fee" action={l.as.organiser && ['active', 'suspended', 'expired'].includes(l.stage_now) && Number(l.fee_minor) ? '+ Issue fee' : undefined} onAction={() => setForm('fee')} />
          <Fees licence={l} reloadKey={l.row_version} openIssue={form === 'fee'} closeIssue={() => setForm(null)} onDone={done} />

          <LSection title="Deliverables" sub="Sponsor and content obligations; the sponsorship stays in Sponsorship" action={l.as.organiser ? '+ Add' : undefined} onAction={() => setForm('deliver')} />
          <Deliverables licence={l} onDone={done} />

          <LSection title="History" />
          <LCard>{l.history.map((h, i) => <T key={i} size={12.5} color={c.mute}>{fmtDT(h.at)} · <T size={12.5} weight="800">{nice(h.action)}</T>{h.actor_name ? ` · ${h.actor_name}` : ''}{h.detail?.reason ? ` · ${h.detail.reason}` : ''}</T>)}</LCard>
        </>
      )}
      {l ? (
        <>
          <ReasonSheet visible={!!ask} onClose={() => setAsk(null)} title={ask === 'decline' ? 'Decline this licence' : ask === 'suspend' ? 'Suspend this licence' : 'End these rights'} sub={ask === 'suspend' ? 'Access stops straight away, including data-feed credentials. You can reinstate it.' : ask === 'terminate' ? 'This ends the rights and every credential that depends on them.' : 'Say why, so the other side can respond.'}
            presets={ask === 'suspend' ? ['Payment query', 'Breach under review', 'Safety'] : ask === 'terminate' ? ['Breach of terms', 'By agreement', 'Event cancelled'] : ['Terms not agreed', 'No longer needed']} confirmLabel={ask === 'suspend' ? 'Suspend' : ask === 'terminate' ? 'End rights' : 'Decline'} tone="live"
            onConfirm={async (reason) => { await decide(ask, reason); }} />
          <FormSheet visible={form === 'revise'} onClose={() => setForm(null)} title="Counter-propose" fields={termFields({ rights: l.package_rights, platforms: l.package_platforms })} initial={termsInitial(l)} submitLabel="Send revised terms"
            onSubmit={async (v) => { await api.post(`/media/licences/${id}/terms`, { ...termsBody(v), row_version: l.row_version }).catch((x) => { throw new Error(explainErr(x)); }); done(); return 'Revised terms sent'; }} />
          <FormSheet visible={form === 'renew'} onClose={() => setForm(null)} title="Renew these rights" notice="Same rights, a new window. The other side must accept it, and this licence is left exactly as it is."
            fields={[{ key: 'effective_from', toKey: 'effective_to', label: 'New dates', type: 'daterange', min: today() }, { key: 'currency', label: 'Currency', type: 'currency', default: l.currency }, { key: 'fee_minor', label: 'Fee for the new term', type: 'money', currency: l.currency, optional: true }]}
            initial={{ effective_from: dayOf(l.effective_to) > today() ? dayOf(l.effective_to) : today(), fee_minor: Number(l.fee_minor) }} submitLabel="Propose renewal"
            onSubmit={async (v) => { const s = spanIso(v.effective_from, v.effective_to); await api.post(`/media/licences/${id}/renew`, { effective_from: s.from, effective_to: s.to, fee_minor: v.fee_minor }).catch((x) => { throw new Error(explainErr(x)); }); done(); return 'Renewal proposed'; }} />
          <FormSheet visible={form === 'records'} onClose={() => setForm(null)} title="Contract records" notice="The executed legal terms stay in Legal. This only points at them."
            fields={[{ key: 'contract_ref', label: 'Contract reference', optional: true }, { key: 'agreement_id', label: 'Organisation agreement', type: 'chips', optional: true, options: (Array.isArray(agreements.data) ? agreements.data : agreements.data?.items ?? []).filter((a) => ['approved', 'signed'].includes(a.status)).map((a) => ({ value: a.id, label: a.title })), hint: 'Approved or signed agreements of your own organisation' }]}
            initial={{ contract_ref: l.contract_ref ?? undefined, agreement_id: l.agreement_id ?? undefined }} submitLabel="Save records" onSubmit={async (v) => { await api.post(`/media/licences/${id}/records`, { contract_ref: v.contract_ref, agreement_id: v.agreement_id }); done(); return 'Records linked'; }} />
          <FormSheet visible={form === 'feed'} onClose={() => setForm(null)} title="Grant a data feed" notice="The partner issues its own credential, so the secret is never shown to anyone else. The feed reads official scoring and results; nothing is copied."
            fields={[{ key: 'consumer_name', label: 'Consumer / system name' }, { key: 'datasets', label: 'Datasets', type: 'multi', options: DATASETS }, { key: 'mode', label: 'Scope', type: 'chips', options: [{ value: 'live', label: 'Live' }, { value: 'delayed', label: 'Delayed' }], default: 'live' },
              { key: 'delay_seconds', label: 'Delay', type: 'stepper', min: 60, max: 3600, step: 60, suffix: ' s', default: 900, show: (v) => v.mode === 'delayed' }, { key: 'rate_per_minute', label: 'Calls per minute', type: 'stepper', min: 1, max: 6000, step: 10, default: 60 }, { key: 'daily_quota', label: 'Calls per day', type: 'stepper', min: 100, max: 1000000, step: 1000, default: 50000 },
              { key: 'valid_to', label: 'Ends on', type: 'date', min: today(), max: dayOf(l.effective_to) }]}
            submitLabel="Grant access" onSubmit={async (v) => { await api.post(`/media/licences/${id}/feeds`, { ...v, valid_to: spanIso(v.valid_to).to, delay_seconds: v.mode === 'delayed' ? v.delay_seconds : undefined }).catch((x) => { throw new Error(x.details?.code === 'no_data_feed_right' ? 'This licence does not carry the data-feed right' : x.message); }); done(); return 'Data feed granted'; }} />
          <FormSheet visible={form === 'deliver'} onClose={() => setForm(null)} title="Add a deliverable"
            fields={[{ key: 'kind', label: 'Kind', type: 'chips', options: [{ value: 'naming_mention', label: 'Naming mention' }, { value: 'graphic_overlay', label: 'Graphic / overlay' }, { value: 'content_piece', label: 'Content piece' }, { value: 'signage', label: 'Signage' }, { value: 'other', label: 'Other' }], default: 'naming_mention' }, { key: 'title', label: 'What must be delivered' }, { key: 'detail', label: 'Detail', type: 'multiline', optional: true }, { key: 'due_at', label: 'Due', type: 'datetime', optional: true }]}
            submitLabel="Add deliverable" onSubmit={async (v) => { await api.post(`/media/licences/${id}/deliverables`, v); done(); return 'Deliverable added'; }} />
        </>
      ) : null}
    </Sheet>
  );
}

function FeedCard({ f, l, onDone, toast }) {
  const [secret, setSecret] = useState(null);
  const [ask, setAsk] = useState(false);
  const issue = async () => { try { setSecret(await api.post(`/media/feeds/${f.id}/credential`, {})); onDone(); } catch (x) { toast(x.message); } };
  return (
    <LCard>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}><T size={15} weight="800">{f.consumer_name}</T><LTag state={f.usable ? 'usable' : f.status === 'revoked' ? 'revoked' : 'expired'} label={f.usable ? 'Active' : f.status === 'revoked' ? 'Ended' : 'Expired'} /></View>
      <T size={12.5} color={c.mute}>{f.datasets.map(nice).join(' · ')} · {f.mode === 'live' ? 'real-time' : `delayed ${f.delay_seconds}s`} · {f.rate_per_minute}/min · {f.daily_quota}/day · until {fmtRange(f.valid_to)}</T>
      <T size={12.5} color={c.mute}>{f.credential_issued ? `Credential issued · ${f.calls_today} calls today · ${f.calls_30d} in 30 days` : 'No credential issued yet'}</T>
      {f.revoke_reason ? <T size={12.5} color={c.red}>{f.revoke_reason}</T> : null}
      {secret ? (
        <LCard color={c.sunSoft} pad={10}>
          <T size={12} weight="800">COPY THIS NOW — IT IS SHOWN ONCE</T>
          <T size={12.5} weight="700" selectable style={{ fontFamily: 'monospace' }}>{secret.token}</T>
          <T size={11.5} color={c.mute}>{secret.usage}</T>
        </LCard>
      ) : null}
      {f.usable ? (
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          {l.as.partner && l.as.can_act ? <ABtn small title={f.credential_issued ? 'Re-issue credential' : 'Issue credential'} tone="neon" onPress={issue} /> : null}
          {l.as.can_act ? <ABtn small title="End feed" tone="ghost" onPress={() => setAsk(true)} /> : null}
        </View>
      ) : null}
      <ReasonSheet visible={ask} onClose={() => setAsk(false)} title="End this data feed" sub="Its credential stops working on the very next request." presets={['Breach of terms', 'No longer needed', 'Credential exposed']} confirmLabel="End feed" onConfirm={async (reason) => { try { await api.post(`/media/feeds/${f.id}/revoke`, { reason }); onDone('Feed ended'); } catch (x) { toast(x.message); } }} />
    </LCard>
  );
}

function Deliverables({ licence, onDone }) {
  const { toast } = useSession();
  const d = useLoad(() => api.get(`/media/licences/${licence.id}/deliverables`), [licence.id, licence.row_version]);
  const [evidence, setEvidence] = useState(null);
  const [measure, setMeasure] = useState(false);
  if (!d.data) return <Loading />;
  const set = async (x, status, extra = {}) => { try { await api.post(`/media/deliverables/${x.id}/status`, { status, ...extra }); d.reload(); } catch (e) { toast(e.message); } };
  return (
    <>
      {!d.data.items.length ? <LEmpty title="No deliverables" sub={licence.as.organiser ? 'Add naming mentions, overlays or content the partner owes.' : 'The organiser has not set any.'} /> : d.data.items.map((x) => (
        <LCard key={x.id}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}><T size={14.5} weight="800" style={{ flex: 1 }}>{x.title}</T><LTag state={x.status} /></View>
          <T size={12.5} color={c.mute}>{nice(x.kind)}{x.due_at ? ` · due ${fmtDT(x.due_at)}` : ''}{x.sponsor_name ? ` · ${x.sponsor_name} (${nice(x.sponsorship_status)})` : ''}</T>
          {x.evidence_url ? <T size={12.5} color={c.violet} selectable>{x.evidence_url}</T> : null}
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            {licence.as.can_act && ['planned', 'missed'].includes(x.status) ? <ABtn small title="Mark delivered" tone="lime" onPress={() => setEvidence(x)} /> : null}
            {licence.as.organiser && x.status === 'delivered' ? <ABtn small title="Verify" tone="neon" onPress={() => set(x, 'verified')} /> : null}
            {licence.as.organiser && ['planned', 'delivered'].includes(x.status) ? <ABtn small title="Missed" tone="ghost" onPress={() => set(x, 'missed')} /> : null}
          </View>
        </LCard>
      ))}
      <LSection title="Measured reach" sub={d.data.note} action={licence.as.can_act ? '+ Record' : undefined} onAction={() => setMeasure(true)} />
      {d.data.measurements.map((m) => <T key={m.id} size={12.5} color={c.mute}>{nice(m.metric)}: <T size={12.5} weight="800">{Number(m.value).toLocaleString()}</T> · {fmtRange(m.period_start, m.period_end)} · {m.source_name}</T>)}
      <FormSheet visible={!!evidence} onClose={() => setEvidence(null)} title="Evidence of delivery" fields={[{ key: 'evidence_url', label: 'Link to the proof (https)', hint: 'A clip, a screenshot or a report that shows it was delivered' }]} submitLabel="Mark delivered"
        onSubmit={async (v) => { await api.post(`/media/deliverables/${evidence.id}/status`, { status: 'delivered', evidence_url: v.evidence_url }); d.reload(); return 'Marked delivered'; }} />
      <FormSheet visible={measure} onClose={() => setMeasure(false)} title="Record a measured number" notice="Only numbers a named provider or analytics source reported. SportArena never estimates reach or ROI."
        fields={[{ key: 'metric', label: 'Metric', type: 'chips', options: [{ value: 'views', label: 'Views' }, { value: 'unique_viewers', label: 'Unique viewers' }, { value: 'peak_concurrent', label: 'Peak concurrent' }, { value: 'watch_minutes', label: 'Watch minutes' }, { value: 'impressions', label: 'Impressions' }], default: 'views' },
          { key: 'value', label: 'Value', type: 'number' }, { key: 'period_start', toKey: 'period_end', label: 'Period', type: 'daterange' }, { key: 'source_name', label: 'Source (provider or analytics tool)' }, { key: 'source_ref', label: 'Report or export reference' }]}
        submitLabel="Record" onSubmit={async (v) => { const s = spanIso(v.period_start, v.period_end); await api.post(`/media/licences/${licence.id}/measurements`, { ...v, period_start: s.from, period_end: s.to }); d.reload(); return 'Recorded'; }} />
    </>
  );
}

const FEE_TAG = { awaiting_payment: 'sun', paid: 'green', cancelled: 'mute', refunded: 'orange' };

/** Fees invoiced against a licence, with the contracted / invoiced / collected / outstanding picture in the licence's own currency. */
function Fees({ licence: l, reloadKey, openIssue, closeIssue, onDone }) {
  const { toast } = useSession();
  const d = useLoad(() => api.get(`/media/licences/${l.id}/fees`), [l.id, reloadKey]);
  const [pay, setPay] = useState(null);
  const [recv, setRecv] = useState(null);
  const [cancel, setCancel] = useState(null);
  const { user } = useSession();
  if (d.error) return <ErrorBox error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  const t = d.data.totals, cur = t.currency;
  const act = async (fn, ok) => { try { await fn(); toast(ok); d.reload(); } catch (x) { toast(x.message); } };
  return (
    <>
      {Number(t.contracted_minor) ? (
        <LCard>
          <T size={12.5} color={c.mute}>{cur} · contracted {money(t.contracted_minor, cur)}</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 14 }}>
            {[['Invoiced', t.invoiced_minor], ['Collected', t.collected_minor], ['Outstanding', t.outstanding_minor], ['Not yet invoiced', t.not_yet_invoiced_minor]].map(([k, v]) => <View key={k}><T size={11.5} weight="700" color={c.mute}>{k.toUpperCase()}</T><T size={16} weight="800">{money(v, cur)}</T></View>)}
          </View>
        </LCard>
      ) : <LEmpty title="No fee on this licence" sub="Agree a fee in the terms to invoice it." />}
      {d.data.fees.map((f) => (
        <LCard key={f.id}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <View style={{ flex: 1 }}><T weight="800">{f.number} · {money(f.amount_minor, f.currency)}</T><T size={12.5} color={c.mute}>{[f.description, f.due_on ? `due ${fmtD(f.due_on)}` : null, f.paid_at ? `paid ${fmtD(f.paid_at)} ${f.paid_method === 'offline' ? `(recorded as received${f.offline_ref ? `: ${f.offline_ref}` : ''})` : '(online)'}` : null, f.cancel_reason].filter(Boolean).join(' · ')}</T></View>
            <LTag state={f.overdue ? 'attention' : f.status === 'paid' ? 'verified' : f.status === 'awaiting_payment' ? 'proposed' : f.status === 'refunded' ? 'attention' : 'declined'} label={f.overdue ? 'Overdue' : nice(f.status)} />
          </View>
          {f.status === 'awaiting_payment' ? (
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              {d.data.as.can_pay && f.payer_id === user.id ? <ABtn small title="Pay now" tone="lime" onPress={() => setPay({ type: 'media_rights_fee', id: f.id, label: `Rights fee ${f.number}`, amount: Number(f.amount_minor), currency: f.currency })} /> : null}
              {d.data.as.can_pay && f.payer_id !== user.id ? <ABtn small title="Make me the payer" tone="ghost" onPress={() => act(() => api.post(`/media/fees/${f.id}/payer`, {}), 'You are now the payer')} /> : null}
              {d.data.as.organiser ? <ABtn small title="Record as received" tone="neon" onPress={() => setRecv(f)} /> : null}
              {d.data.as.organiser ? <ABtn small title="Cancel" tone="ghost" onPress={() => setCancel(f)} /> : null}
            </View>
          ) : null}
        </LCard>
      ))}
      {pay ? <PaySheet target={pay} onClose={() => setPay(null)} onDone={() => { d.reload(); onDone(); }} /> : null}
      <FormSheet visible={openIssue} onClose={closeIssue} title="Issue a rights fee" notice={`Billed in ${cur}. The total invoiced can never exceed the contracted fee (${money(t.contracted_minor, cur)}); ${money(t.not_yet_invoiced_minor, cur)} is still to invoice.`}
        fields={[{ key: 'amount_minor', label: 'Amount', type: 'money', currency: cur, optional: true, hint: 'Leave empty to invoice everything still to invoice' }, { key: 'due_on', label: 'Due date', type: 'date', optional: true, min: dayOf(new Date().toISOString()) }, { key: 'description', label: 'Description', optional: true, hint: 'Deposit, final instalment …' }]}
        submitLabel="Issue fee" onSubmit={async (v) => { await api.post(`/media/licences/${l.id}/fees`, v).catch((x) => { throw new Error(x.message); }); d.reload(); onDone(); return 'Fee issued. The partner has been notified.'; }} />
      <FormSheet visible={!!recv} onClose={() => setRecv(null)} title="Record as received" notice="Use this when the fee was paid outside the platform. It then counts as collected, marked as recorded offline."
        fields={[{ key: 'reference', label: 'Reference', hint: 'Bank transfer reference, cheque number …' }]} submitLabel="Record" onSubmit={async (v) => { await api.post(`/media/fees/${recv.id}/received`, v); d.reload(); onDone(); return 'Recorded'; }} />
      <ReasonSheet visible={!!cancel} onClose={() => setCancel(null)} title="Cancel this fee" sub="It stays on record, stops counting as invoiced, and can be issued again." presets={['Wrong amount', 'Wrong payer', 'Terms changed']} confirmLabel="Cancel fee" tone="live"
        onConfirm={async (reason) => { try { await api.post(`/media/fees/${cancel.id}/cancel`, { reason }); d.reload(); onDone(); } catch (x) { toast(x.message); } }} />
    </>
  );
}
