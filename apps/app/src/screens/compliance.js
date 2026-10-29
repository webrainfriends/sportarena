// Compliance, policy & evidence (#568). One engine, two entry points: the event console's Compliance tab (the organiser's dashboard of permits,
// badges, eligibility and tenders) and the Compliance page under More (the rules in force and my own evidence). All logic is in the API; this only
// calls it. Nothing here claims legal compliance: it shows what the rules ask, what evidence is on file and what a person has verified.
import React, { useState } from 'react';
import { Linking, Pressable, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useDo } from './console-utils';
import { A, AChip, ACard, ABtn, AEmpty, AHero, ARow, AScreen, ASection, AStat, AT, ATabs, ATag, ReasonSheet } from '../arena';
import { FormSheet } from '../FormSheet';
import { Btn, Chip, ErrorBox, Field, HScroll, Loading, Sheet, T } from '../ui';
import { c } from '../theme';
import { locale } from '../locale';
import { CountryPicker, countryName } from '../country-picker';
import { DateField } from '../pickers';
import { SportsMulti } from '../sportpicker';

const STATUS = {
  compliant: ['Compliant', A.green], expiring: ['Expiring', A.sun], pending: ['Pending review', A.cyan], missing: ['Missing', A.orange], exception: ['Exception', A.violet],
  non_compliant: ['Non-compliant', A.red], unknown: ['Unknown', A.mute], no_rules: ['No rules', A.mute],
};
const OUTCOME = { applies: 'Applies', does_not_apply: 'Does not apply', unknown: 'Cannot tell yet', exception_required: 'Exception required' };
const CLASS = { legal_mandatory: 'Legal', regulatory: 'Regulatory', federation_mandated: 'Federation', contractual: 'Contractual', organisation_policy: 'Organisation', recommended_standard: 'Recommended' };
const CLASS_TONE = { legal_mandatory: A.red, regulatory: A.orange, federation_mandated: A.violet, contractual: A.cyan, organisation_policy: A.sun, recommended_standard: A.mute };
const KIND = { licence: 'Licence', permit: 'Permit', declaration: 'Declaration', certificate: 'Certificate', training: 'Training', insurance: 'Insurance', background_check: 'Background check', signed_document: 'Signed document', approval: 'Approval' };
const HOLDER = { person: 'Person', organisation: 'Organisation', event: 'Event', venue: 'Venue', tender: 'Tender', supplier_entity: 'Supplier', subject: 'Whoever is being checked' };
const ROLE = { athlete: 'Athlete', team_staff: 'Team staff', official: 'Official', medical: 'Medical', volunteer: 'Volunteer', security: 'Security', media: 'Media', vendor: 'Vendor', sponsor: 'Sponsor', hospitality: 'Hospitality', operations: 'Operations', guest: 'Guest', supplier: 'Supplier' };
const TYPES = { tournament: 'Tournament', league: 'League', friendly: 'Friendly', camp: 'Camp', trial: 'Trial' };
const DOMAIN = { procurement: 'Procurement', event_permit: 'Event permits', federation_eligibility: 'Federation eligibility', accreditation: 'Accreditation', youth_safeguarding: 'Youth safeguarding', privacy: 'Privacy', general: 'General' };
const TRIGGER = { accreditation_approve: 'Badge approval', event_open: 'Event opened to entrants', event_start: 'Event start', award_recommend: 'Tender award recommended', eligibility: 'Match-day eligibility', manual: 'Checked and recorded', gate: 'Gate check' };
const dateShort = (d) => (d ? new Date(`${String(d).slice(0, 10)}T12:00:00`).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const stamp = (d) => (d ? new Date(d).toLocaleString(locale, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '');
const slug = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'rule';
const where = (v) => [v.municipality, v.region, v.country ? countryName(v.country) : null].filter(Boolean).join(', ') || 'Anywhere';
const endOfDay = (d) => new Date(`${d}T23:59:59`).toISOString();

export const StatusTag = ({ s }) => <ATag label={(STATUS[s] ?? [s])[0]} tone={(STATUS[s] ?? [])[1]} />;
const ClassTag = ({ k }) => <ATag label={CLASS[k] ?? k} tone={CLASS_TONE[k]} />;

// ------------------------------------------------------------------ what one subject owes

/** Facts, rules and requirements for one subject, with the next step beside each gap. Never says "compliant by law". */
function SubjectSheet({ subject, event, onClose, onChanged, canManage = true }) {
  const { toast } = useSession();
  const act = useDo(() => { r.reload(); onChanged?.(); });
  const ctx = event ? { event_id: event.id } : {};
  const r = useLoad(() => (subject ? api.post('/compliance/evaluate', { subject_type: subject.subject_type, subject_id: subject.subject_id, domain: subject.domain, ...ctx, category_roles: subject.category_roles }) : Promise.resolve(null)), [subject?.subject_id, subject?.domain]);
  const [words, setWords] = useState(null);
  const [form, setForm] = useState(null);
  const [waive, setWaive] = useState(null);
  const d = r.data;
  const explain = async () => {
    try { const x = await api.post('/compliance/explain', { subject_type: subject.subject_type, subject_id: subject.subject_id, domain: subject.domain, ...ctx, category_roles: subject.category_roles }); setWords(x.text); }
    catch (x) { toast('' + x.message); }
  };
  const holderId = (h) => (h === 'subject' ? subject.subject_id : h === 'event' ? event?.id : null);
  return (
    <Sheet visible={!!subject} onClose={onClose} title={subject?.label ?? 'Compliance'}>
      {r.error ? <ErrorBox error={r.error} onRetry={r.reload} /> : !d ? <Loading /> : (
        <View style={{ gap: 12 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <StatusTag s={d.summary.overall} />
            <T size={12} color={c.mute}>Rules in force on {dateShort(d.as_of)}</T>
          </View>
          <View accessible accessibilityLabel="Facts used" style={{ gap: 4 }}>
            <T weight="800" size={13}>What we know</T>
            {Object.keys(d.facts.values).length ? Object.entries(d.facts.values).filter(([k]) => !k.endsWith('_id') && !k.endsWith('_ids')).map(([k, v]) => (
              <T key={k} size={12.5} color={c.mute}><T size={12.5} weight="700">{k.replace(/_/g, ' ')}:</T> {Array.isArray(v) ? v.join(', ') : String(v)}  ·  {d.facts.sources[k] ?? ''}</T>
            )) : <T size={12.5} color={c.mute}>Nothing on record yet (add the venue's address to the event so place-based rules can be judged).</T>}
          </View>
          {d.results.filter((x) => x.outcome !== 'does_not_apply').length === 0 ? <T color={c.mute}>No rule in force applies here on that date. That is not a statement that nothing is required.</T> : null}
          {d.results.filter((x) => x.outcome !== 'does_not_apply').map((x) => (
            <View key={x.version_id} style={{ borderWidth: 1, borderColor: c.line, borderRadius: 16, padding: 12, gap: 8 }}>
              <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}><ClassTag k={x.classification} /><StatusTag s={x.status} /><T size={11.5} color={c.mute}>{OUTCOME[x.outcome]}</T></View>
              <T weight="800">{x.title}</T>
              <T size={12} color={c.mute}>{where(x)} · version {x.version} · from {dateShort(x.effective_from)}{x.source_title ? ` · ${x.source_title}` : ''}</T>
              {x.reason ? <T size={12.5} color={c.mute}>{x.reason}</T> : null}
              {x.requirements.map((q) => (
                <View key={q.key} style={{ gap: 4, borderTopWidth: 1, borderColor: c.line, paddingTop: 8 }}>
                  <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><T weight="700" size={13.5} style={{ flexShrink: 1 }}>{q.label}</T><StatusTag s={q.status} /></View>
                  <T size={12} color={c.mute}>{KIND[q.kind]} · {HOLDER[q.holder] ?? q.holder} · {q.detail}</T>
                  {['missing', 'non_compliant', 'pending'].includes(q.status) && canManage && q.status !== 'pending' && holderId(q.holder)
                    ? <Btn small title={`Add ${KIND[q.kind].toLowerCase()}`} onPress={() => setForm({ holder_type: q.holder === 'subject' ? subject.subject_type : q.holder, holder_id: holderId(q.holder), kind: q.kind, requirement_key: q.key, title: q.label })} style={{ alignSelf: 'flex-start' }} /> : null}
                </View>
              ))}
              {x.waivable && canManage && ['missing', 'pending', 'non_compliant'].includes(x.status) ? <Btn small color={c.violet} title="Grant an exception…" onPress={() => setWaive(x)} style={{ alignSelf: 'flex-start' }} /> : null}
            </View>
          ))}
          {d.results.filter((x) => x.outcome === 'does_not_apply').length ? (
            <T size={12} color={c.mute}>Not applying here: {d.results.filter((x) => x.outcome === 'does_not_apply').map((x) => x.superseded_by ? `${x.title} (overridden by ${x.superseded_by.title})` : x.title).join(' · ')}</T>
          ) : null}
          {words ? <ACard><AT size={13.5} weight="600" style={{ lineHeight: 20 }}>{words}</AT></ACard> : <Btn small title="Explain in plain words" color={c.cyan ?? c.violet} onPress={explain} style={{ alignSelf: 'flex-start' }} />}
          {canManage ? <Btn small title="Record this check in the audit trail" color={c.paper} ink={c.ink} onPress={() => act(() => api.post('/compliance/evaluate', { subject_type: subject.subject_type, subject_id: subject.subject_id, domain: subject.domain, ...ctx, category_roles: subject.category_roles, record: true }), 'Recorded')} style={{ alignSelf: 'flex-start' }} /> : null}
          <T size={11.5} color={c.mute}>This shows what the rules ask and what evidence is on file. A person decides whether a requirement is met; an uploaded document counts only once it has been verified.</T>
        </View>
      )}
      <EvidenceForm visible={!!form} preset={form} event={event} onClose={() => setForm(null)} onDone={() => { setForm(null); r.reload(); onChanged?.(); }} />
      <WaiveForm rule={waive} subject={subject} event={event} onClose={() => setWaive(null)} onDone={() => { setWaive(null); r.reload(); onChanged?.(); }} />
    </Sheet>
  );
}

function WaiveForm({ rule, subject, event, onClose, onDone }) {
  return (
    <FormSheet visible={!!rule} onClose={onClose} title={`Exception: ${rule?.title ?? ''}`} submitLabel="Grant exception" color={c.violet}
      notice="An exception waives this one rule for a limited time, is recorded with your name and reason, and shows in every decision that relies on it."
      fields={[{ key: 'reason', label: 'Why is this safe to waive?', type: 'multiline' }, { key: 'until', label: 'Waived until', type: 'date' }]}
      onSubmit={async (v) => {
        if (!v.reason || v.reason.trim().length < 10) throw new Error('Give a reason of at least a sentence');
        if (!v.until) throw new Error('Choose the last day of the exception');
        await api.post('/compliance/exceptions', { rule_id: rule.rule_id, holder_type: subject.subject_type, holder_id: subject.subject_id, event_id: event?.id, reason: v.reason.trim(), valid_to: endOfDay(v.until) });
        onDone();
      }} />
  );
}

// ------------------------------------------------------------------ evidence

/** File evidence: the right control for each answer (kind chips, calendar dates, a pick of the event), the number kept encrypted. */
export function EvidenceForm({ visible, preset, event, onClose, onDone, holder }) {
  const { user } = useSession();
  const mine = useLoad(() => (visible && !event && !preset ? api.get('/events', { organizer_id: user.id, limit: 50 }).catch(() => []) : Promise.resolve([])), [visible]);
  const h = holder ?? (preset ? { type: preset.holder_type, id: preset.holder_id } : { type: 'person', id: user.id });
  return (
    <FormSheet visible={visible} onClose={onClose} title="Add evidence" submitLabel="File it" color={c.violet} initial={{ kind: preset?.kind ?? 'certificate', title: preset?.title ?? '' }}
      notice="The number is stored encrypted. Everything except a declaration waits for a reviewer: a document on its own is never treated as proof."
      fields={[
        { key: 'kind', label: 'What is it?', type: 'chips', options: Object.entries(KIND).map(([value, label]) => ({ value, label })) },
        { key: 'title', label: 'Name', hint: 'For example "Fire safety certificate"' },
        { key: 'issuer', label: 'Issued by', optional: true },
        { key: 'reference', label: 'Number or reference (kept encrypted)', optional: true },
        { key: 'document_ref', label: 'Where the document is kept (link or note)', optional: true },
        { key: 'issued_on', label: 'Issued on', type: 'date', optional: true },
        { key: 'valid_to', label: 'Valid until', type: 'date', optional: true },
        ...(!event && !preset ? [{ key: 'event', label: 'File it for one event (its organiser reviews it)', type: 'entity', entityKind: 'team', noun: 'event', options: (mine.data ?? []).map((e) => ({ id: e.id, label: e.name, sub: e.starts_on })), optional: true }] : []),
      ]}
      onSubmit={async (v) => {
        const eventId = event?.id ?? (Array.isArray(v.event) ? v.event[0]?.id : v.event) ?? undefined;
        await api.post('/compliance/evidence', { holder_type: h.type, holder_id: h.id, event_id: eventId, kind: v.kind, requirement_key: preset?.requirement_key, title: v.title, issuer: v.issuer || undefined, reference: v.reference || undefined, document_ref: v.document_ref || undefined, issued_on: v.issued_on || undefined, valid_to: v.valid_to || undefined });
        onDone();
      }} />
  );
}

const EV_TONE = { verified: A.green, submitted: A.cyan, rejected: A.red, revoked: A.red };
const EV_LABEL = { verified: 'Verified', submitted: 'Waiting for a reviewer', rejected: 'Rejected', revoked: 'Revoked' };

function EvidenceRow({ e, review, onReview }) {
  return (
    <ARow title={e.title} sub={`${KIND[e.kind] ?? e.kind}${e.issuer ? ` · ${e.issuer}` : ''}${e.valid_to ? ` · until ${dateShort(e.valid_to)}` : ''}${e.has_reference ? ' · number on file' : ''}`}
      right={<><ATag label={EV_LABEL[e.status]} tone={EV_TONE[e.status]} />{review ? (
        <View style={{ flexDirection: 'row', gap: 6 }}>
          <ABtn small title="Verify" tone="lime" onPress={() => onReview(e, 'verify')} />
          <ABtn small title="Reject" tone="ghost" onPress={() => onReview(e, 'reject')} />
        </View>) : null}</>} />
  );
}

function ReviewSheets({ ask, setAsk, done }) {
  return (
    <>
      <FormSheet visible={ask?.how === 'verify'} onClose={() => setAsk(null)} title="Verify evidence" submitLabel="Verify" color={c.violet}
        notice="Say what you actually checked. This is recorded with your name."
        fields={[{ key: 'verified_what', label: 'What did you check?', type: 'multiline', hint: 'For example: original seen, number matches the register' }]}
        onSubmit={async (v) => { await api.post(`/compliance/evidence/${ask.e.id}/review`, { decision: 'verify', verified_what: v.verified_what }); setAsk(null); done('Verified'); }} />
      <ReasonSheet visible={ask?.how === 'reject'} onClose={() => setAsk(null)} title="Reject evidence" presets={['Not legible', 'Expired', 'Does not match the requirement', 'Could not be confirmed']} confirmLabel="Reject"
        onConfirm={async (note) => { await api.post(`/compliance/evidence/${ask.e.id}/review`, { decision: 'reject', note }); done('Rejected'); }} />
    </>
  );
}

// ------------------------------------------------------------------ the event console tab

const SECTION_NOTE = { event_permit: 'Permits, insurance and approvals for the event itself', accreditation: 'Who is waiting for, or holds, a badge', federation_eligibility: 'Registered players', procurement: 'Tenders for this event' };

export function ComplianceTab({ id, e, isOrg }) {
  const { toast } = useSession();
  const dash = useLoad(() => (isOrg ? api.get(`/events/${id}/compliance`) : Promise.resolve(null)), [id, isOrg]);
  const queue = useLoad(() => (isOrg ? api.get('/compliance/review-queue', { event_id: id }) : Promise.resolve([])), [id, isOrg]);
  const log = useLoad(() => (isOrg ? api.get('/compliance/decisions', { event_id: id, limit: 30 }) : Promise.resolve([])), [id, isOrg]);
  const [sub, setSub] = useState('overview');
  const [open, setOpen] = useState(null);
  const [form, setForm] = useState(false);
  const [ask, setAsk] = useState(null);
  const [detail, setDetail] = useState(null);
  const reloadAll = () => { dash.reload(); queue.reload(); log.reload(); };
  if (!isOrg) return <AEmpty emoji="🛡️" title="Compliance is run by the organiser" sub="If you were asked for a permit, certificate or declaration, open Compliance under More to file it." />;
  if (dash.error) return <ErrorBox error={dash.error} onRetry={dash.reload} />;
  const d = dash.data;
  if (!d) return <Loading />;
  const t = d.totals;
  return (
    <View style={{ gap: 12 }}>
      <AT size={13} color={A.mute}>Read live from the rules in force: a rule change shows here at once. This is a checklist of what the rules ask and what has been verified, not legal advice.</AT>
      <ATabs value={sub} onChange={setSub} tabs={[{ key: 'overview', label: 'Overview' }, { key: 'review', label: `To review${queue.data?.length ? ` · ${queue.data.length}` : ''}` }, { key: 'log', label: 'Decisions' }]} />
      {sub === 'overview' ? (
        <>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {['compliant', 'expiring', 'pending', 'missing', 'exception', 'non_compliant', 'unknown'].map((s) => <AStat key={s} value={t[s] ?? 0} label={STATUS[s][0]} tone={t[s] ? STATUS[s][1] : undefined} />)}
          </View>
          {d.truncated ? <T size={12} color={A.mute}>Showing the first 100 people in each list.</T> : null}
          {Object.entries(d.sections).map(([key, sec]) => (
            <View key={key} style={{ gap: 8 }}>
              <ASection title={sec.label} sub={SECTION_NOTE[key]} />
              {sec.subjects.length === 0 ? <ACard><AT size={13} color={A.mute}>Nothing to check yet.</AT></ACard> : sec.subjects.map((s) => (
                <ARow key={`${s.subject_type}${s.subject_id}${s.detail ?? ''}`} title={s.label} onPress={() => setOpen({ ...s, domain: key })}
                  sub={s.overall === 'no_rules' ? 'No rule applies' : s.blockers.length ? s.blockers.map((b) => b.title).join(' · ') : s.unknown_facts.length ? `Needs: ${s.unknown_facts.join(', ')}` : (s.detail ?? 'All requirements met')}
                  right={<StatusTag s={s.overall} />} />
              ))}
            </View>
          ))}
          {d.expiring_evidence.length ? (
            <>
              <ASection title="Expiring soon" sub="Verified evidence that lapses within 30 days" />
              {d.expiring_evidence.map((x) => <ARow key={x.id} title={x.title} sub={`${KIND[x.kind]} · ${HOLDER[x.holder_type]} · ends ${dateShort(x.valid_to)}`} right={<StatusTag s="expiring" />} />)}
            </>
          ) : null}
          <ABtn title="Add evidence for this event" tone="neon" onPress={() => setForm(true)} />
        </>
      ) : sub === 'review' ? (
        <>
          <ASection title="Waiting for your review" sub="Evidence filed for this event. You cannot verify what you filed yourself." />
          {queue.data?.length ? queue.data.map((x) => <EvidenceRow key={x.id} e={x} review onReview={(ev, how) => setAsk({ e: ev, how })} />) : <AEmpty emoji="✅" title="Nothing waiting" sub="New evidence filed for this event appears here." />}
        </>
      ) : (
        <>
          <ASection title="Audit trail" sub="Every check that was recorded or that stopped an action" />
          {log.data?.length ? log.data.map((x) => (
            <ARow key={x.id} title={TRIGGER[x.trigger] ?? String(x.trigger).replace(/_/g, ' ')} sub={`${DOMAIN[x.domain] ?? x.domain} · ${stamp(x.created_at)}${x.decided_by_name ? ` · ${x.decided_by_name}` : ''}${x.override_exception_ids?.length ? ' · exception used' : ''}`}
              onPress={() => api.get(`/compliance/decisions/${x.id}`).then(setDetail).catch((z) => toast('' + z.message))}
              right={<><StatusTag s={x.overall} />{x.blocked ? <ATag label="Stopped" tone={A.red} /> : null}</>} />
          )) : <AEmpty emoji="📜" title="No decisions recorded yet" sub="Approvals, starts and awards that were checked against the rules are listed here." />}
        </>
      )}
      <SubjectSheet subject={open} event={e} onClose={() => setOpen(null)} onChanged={reloadAll} />
      <EvidenceForm visible={form} event={e} holder={{ type: 'event', id }} onClose={() => setForm(false)} onDone={() => { setForm(false); toast('Filed. A reviewer will look at it.'); reloadAll(); }} />
      <ReviewSheets ask={ask} setAsk={setAsk} done={(m) => { toast(m); setAsk(null); reloadAll(); }} />
      <DecisionSheet d={detail} onClose={() => setDetail(null)} />
    </View>
  );
}

function DecisionSheet({ d, onClose }) {
  return (
    <Sheet visible={!!d} onClose={onClose} title="Decision as it was taken">
      {d ? (
        <View style={{ gap: 10 }}>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}><StatusTag s={d.overall} />{d.blocked ? <ATag label="Stopped the action" tone={A.red} /> : null}</View>
          <T size={12.5} color={c.mute}>{stamp(d.created_at)} · {d.decided_by_name ?? 'automatic'} · rules in force on {dateShort(d.as_of)}</T>
          {d.results.filter((x) => x.outcome !== 'does_not_apply').map((x) => (
            <View key={x.version_id} style={{ borderWidth: 1, borderColor: c.line, borderRadius: 14, padding: 10, gap: 4 }}>
              <T weight="800">{x.title} <T size={12} color={c.mute}>· version {x.version}</T></T>
              <T size={12} color={c.mute}>{CLASS[x.classification]} · {OUTCOME[x.outcome]} · {(STATUS[x.status] ?? [x.status])[0]}</T>
              {x.requirements.map((q) => <T key={q.key} size={12.5}>• {q.label}: {(STATUS[q.status] ?? [q.status])[0]} — {q.detail}</T>)}
            </View>
          ))}
          {d.exceptions?.length ? <T size={12.5}>Exceptions relied on: {d.exceptions.map((x) => `${x.rule_key} (by ${x.granted_by_name})`).join('; ')}</T> : null}
          <T size={12} color={c.mute}>Facts used: {Object.entries(d.facts.values).filter(([k]) => !k.endsWith('_id') && !k.endsWith('_ids')).map(([k, v]) => `${k.replace(/_/g, ' ')} ${Array.isArray(v) ? v.join('/') : v} (${d.facts.sources[k]})`).join(' · ') || 'none'}</T>
        </View>
      ) : null}
    </Sheet>
  );
}

// ------------------------------------------------------------------ the page under More

export function CompliancePage({ tab: first = 'rules' }) {
  const { user, toast } = useSession();
  const [tab, setTab] = useState(first);
  const cat = useLoad(() => api.get('/compliance/catalogue'), []);
  const [domain, setDomain] = useState(null);
  const [country, setCountry] = useState(null);
  const rules = useLoad(() => api.get('/compliance/rules', { domain: domain ?? undefined, country: country ?? undefined, limit: 100 }), [domain, country]);
  const orgs = useLoad(() => api.get('/organisations').catch(() => []), []);
  const ev = useLoad(() => api.get('/compliance/evidence', { holder_type: 'person', holder_id: user.id, limit: 100 }), [user.id]);
  const [wizard, setWizard] = useState(null);
  const [open, setOpen] = useState(null);
  const [form, setForm] = useState(false);
  const isPlatform = !!user.roles?.includes('platform_admin');
  const adminOrgs = (orgs.data ?? []).filter((o) => o.my_status === 'active' && ['owner', 'admin'].includes(o.my_role));
  const canWrite = isPlatform || adminOrgs.length > 0;
  const soon = (ev.data ?? []).filter((x) => x.status === 'verified' && x.valid_to && x.valid_to <= new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10));
  return (
    <AScreen>
      <AHero kicker="Compliance" title="Rules and evidence" sub="One set of versioned rules for permits, eligibility, accreditation and procurement. Nothing here is legal advice." emoji="🛡️" />
      <ATabs value={tab} onChange={setTab} tabs={[{ key: 'rules', label: 'Rules in force' }, { key: 'mine', label: `My evidence${soon.length ? ` · ${soon.length} expiring` : ''}` }]} />
      {tab === 'rules' ? (
        <>
          <HScroll>
            <AChip label="All" active={!domain} onPress={() => setDomain(null)} />
            {(cat.data?.domains ?? []).filter((x) => x.key !== 'general').map((x) => <AChip key={x.key} label={x.label} active={domain === x.key} onPress={() => setDomain(domain === x.key ? null : x.key)} />)}
          </HScroll>
          <HScroll>
            <AChip label="Any country" active={!country} onPress={() => setCountry(null)} color={A.cyan} />
            {(cat.data?.jurisdictions ?? []).map((j) => <AChip key={j.code} label={j.name} active={country === j.code} onPress={() => setCountry(country === j.code ? null : j.code)} color={A.cyan} />)}
          </HScroll>
          {canWrite ? <ABtn title="Write a rule" tone="neon" onPress={() => setWizard({})} /> : <T size={12} color={A.mute}>Rules are written by the platform team (laws and regulations) and by owners and admins of an organisation (its own policies). Federation rules come from the federation's console.</T>}
          {rules.error ? <ErrorBox error={rules.error} onRetry={rules.reload} /> : !rules.data ? <Loading /> : rules.data.length === 0 ? (
            <AEmpty emoji="📚" title="No rules yet" sub="When a rule is approved for your place, your organisation or your federation, it appears here with its source and effective date." />
          ) : rules.data.map((r) => {
            const v = r.current ?? r.upcoming;
            return (
              <ARow key={r.id} title={v?.title ?? r.key} onPress={() => setOpen(r.id)}
                sub={`${v ? where(v) : 'Draft only'} · ${r.scope === 'platform' ? 'Platform library' : r.organisation_name} · ${r.domains.map((x) => DOMAIN[x]).join(', ')}`}
                right={<>{v ? <ClassTag k={v.classification} /> : null}{r.repealed ? <ATag label="Repealed" tone={A.mute} /> : !r.current && r.upcoming ? <ATag label={`From ${dateShort(r.upcoming.effective_from)}`} tone={A.sun} /> : null}{r.drafts ? <ATag label={`${r.drafts} draft`} tone={A.cyan} /> : null}</>} />
            );
          })}
        </>
      ) : (
        <>
          <ASection title="My evidence" sub="Licences, certificates, training and declarations you have filed. Verified evidence counts toward the rules." />
          <ABtn title="Add evidence" tone="neon" onPress={() => setForm(true)} />
          {ev.error ? <ErrorBox error={ev.error} onRetry={ev.reload} /> : !ev.data ? <Loading /> : ev.data.length === 0 ? <AEmpty emoji="🗂️" title="Nothing filed yet" sub="When an organiser asks for a certificate or a declaration, file it here or from the request." /> : ev.data.map((x) => <EvidenceRow key={x.id} e={x} />)}
        </>
      )}
      <RuleDetail id={open} onClose={() => setOpen(null)} onChanged={rules.reload} onNewVersion={(rule, v) => { setOpen(null); setWizard({ rule, v }); }} />
      <RuleWizard open={wizard} onClose={() => setWizard(null)} cat={cat.data} isPlatform={isPlatform} orgs={adminOrgs} rules={rules.data ?? []} onDone={() => { setWizard(null); toast('Saved as a draft. It applies once approved.'); rules.reload(); }} />
      <EvidenceForm visible={form} onClose={() => setForm(false)} onDone={() => { setForm(false); ev.reload(); toast('Filed'); }} />
    </AScreen>
  );
}

function RuleDetail({ id, onClose, onChanged, onNewVersion }) {
  const { toast } = useSession();
  const r = useLoad(() => (id ? api.get(`/compliance/rules/${id}`) : Promise.resolve(null)), [id]);
  const act = useDo(() => { r.reload(); onChanged?.(); });
  const d = r.data;
  return (
    <Sheet visible={!!id} onClose={onClose} title={d?.versions?.[0]?.title ?? 'Rule'}>
      {r.error ? <ErrorBox error={r.error} onRetry={r.reload} /> : !d ? <Loading /> : (
        <View style={{ gap: 12 }}>
          <T size={12.5} color={c.mute}>{d.scope_kind === 'platform' ? 'Platform library' : d.organisation_name} · {d.domains.map((x) => DOMAIN[x]).join(', ')} · topic {d.topic}</T>
          {d.versions.map((v) => (
            <View key={v.id} style={{ borderWidth: 1, borderColor: c.line, borderRadius: 16, padding: 12, gap: 6 }}>
              <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <T weight="800">Version {v.version}</T><ClassTag k={v.classification} />
                <ATag label={v.status === 'approved' ? (v.repeals ? 'Repeal' : 'Approved') : v.status === 'draft' ? 'Draft' : 'Withdrawn'} tone={v.status === 'approved' ? A.green : v.status === 'draft' ? A.cyan : A.mute} />
              </View>
              <T weight="700">{v.title}</T>
              {v.summary ? <T size={13} color={c.mute}>{v.summary}</T> : null}
              <T size={12.5} color={c.mute}>{where(v)} · from {dateShort(v.effective_from)}{v.effective_to ? ` to ${dateShort(v.effective_to)}` : ''}</T>
              <T size={12.5} color={c.mute}>Approval owner: {v.approval_owner}{v.approved_at ? ` · approved ${dateShort(v.approved_at)}${v.self_approved ? ' (by its author)' : ''}` : ''}</T>
              {v.source_title || v.source_url ? <Pressable accessibilityRole="link" onPress={() => v.source_url && Linking.openURL(v.source_url)} style={{ minHeight: 44, justifyContent: 'center' }}><T size={13} weight="700" color={c.violet}>Source: {v.source_title ?? v.source_url} ↗</T></Pressable> : null}
              {Object.entries(v.applies ?? {}).filter(([, x]) => (Array.isArray(x) ? x.length : x != null)).length ? <T size={12.5}>Applies to: {Object.entries(v.applies).filter(([, x]) => (Array.isArray(x) ? x.length : x != null)).map(([k, x]) => `${k.replace(/_/g, ' ')} ${Array.isArray(x) ? x.join(', ') : x}`).join(' · ')}</T> : null}
              {v.requirements.map((q) => <T key={q.key} size={12.5}>• {q.label} — {KIND[q.kind]}, held by {HOLDER[q.holder] ?? q.holder}{q.max_age_days ? `, not older than ${q.max_age_days} days` : ''}</T>)}
              {v.waivable ? <T size={12} color={c.mute}>Can be waived by an authorised person, for a limited time.</T> : null}
              {d.can_manage && v.status === 'draft' ? (
                <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                  <Btn small title="Approve" onPress={() => act(() => api.post(`/compliance/versions/${v.id}/decision`, { decision: 'approve' }), 'Approved')} />
                  <Btn small color={c.paper} ink={c.ink} title="Withdraw draft" onPress={() => act(() => api.post(`/compliance/versions/${v.id}/decision`, { decision: 'withdraw' }), 'Withdrawn')} />
                </View>
              ) : null}
            </View>
          ))}
          {d.can_manage ? <Btn title="Write a new version" onPress={() => onNewVersion(d, d.versions.find((v) => v.status === 'approved') ?? d.versions[0])} /> : null}
          <T size={11.5} color={c.mute}>Versions are never edited or deleted: a change is a new version with its own effective date, so any past decision can be explained with the text that was in force.</T>
        </View>
      )}
    </Sheet>
  );
}

// ------------------------------------------------------------------ writing a rule

const empty = { reqs: [] };
function RuleWizard({ open, onClose, cat, isPlatform, orgs, rules, onDone }) {
  const prev = open?.v;
  const [step, setStep] = useState(0);
  const [f, setF] = useState(null);
  const [busy, setBusy] = useState(false);
  const { toast } = useSession();
  const [seen, setSeen] = useState(null);
  if (open && seen !== open) {
    setSeen(open);
    setStep(0);
    setF(prev ? {
      scope: open.rule.scope_kind, organisation_id: open.rule.organisation_id, domains: open.rule.domains, topic: open.rule.topic, title: prev.title, classification: prev.classification, country: prev.country ?? undefined, region: prev.region ?? '', municipality: prev.municipality ?? '',
      roles: prev.applies?.roles ?? [], event_types: prev.applies?.event_types ?? [], sports: prev.applies?.sports ?? [], min_age: prev.applies?.min_age, max_age: prev.applies?.max_age, effective_from: undefined, effective_to: undefined,
      source_title: prev.source_title ?? '', source_url: prev.source_url ?? '', approval_owner: prev.approval_owner, waivable: prev.waivable, reqs: prev.requirements ?? [], change_note: '',
    } : { ...empty, scope: isPlatform ? 'platform' : 'organisation', organisation_id: orgs[0]?.id, domains: [], classification: isPlatform ? 'regulatory' : 'organisation_policy', roles: [], event_types: [], sports: [], region: '', municipality: '', source_title: '', source_url: '', approval_owner: '', waivable: false, title: '' });
  }
  if (!open || !f) return null;
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const toggle = (k, v) => set(k, f[k].includes(v) ? f[k].filter((x) => x !== v) : [...f[k], v]);
  const classes = f.scope === 'platform' ? ['legal_mandatory', 'regulatory', 'recommended_standard'] : ['organisation_policy', 'contractual', 'recommended_standard'];
  const addReq = () => set('reqs', [...f.reqs, { key: `req-${f.reqs.length + 1}-${Math.random().toString(36).slice(2, 5)}`, kind: 'certificate', label: '', holder: 'subject', warn_days: 30 }]);
  const setReq = (i, patch) => set('reqs', f.reqs.map((q, j) => (j === i ? { ...q, ...patch } : q)));
  const check = () => {
    if (step === 0) { if (f.title.trim().length < 3) return 'Give the rule a name'; if (!f.domains.length) return 'Choose what it governs'; if (f.scope === 'organisation' && !f.organisation_id) return 'Choose the organisation'; if (f.municipality && !f.region) return 'A municipality needs its state or province'; if ((f.region || f.municipality) && !f.country) return 'Choose the country first'; }
    if (step === 2) { if (!f.effective_from) return 'Choose the day it takes effect'; if (f.approval_owner.trim().length < 3) return 'Say who is accountable for approving it'; if (f.reqs.some((q) => q.label.trim().length < 3)) return 'Name each piece of evidence'; if (f.source_url && !/^https:\/\//.test(f.source_url)) return 'The source link must start with https://'; }
    return null;
  };
  const next = () => { const m = check(); if (m) toast(m); else setStep(step + 1); };
  const save = async () => {
    const m = check(); if (m) { toast(m); return; }
    setBusy(true);
    try {
      const applies = {};
      if (f.roles.length) applies.roles = f.roles;
      if (f.event_types.length) applies.event_types = f.event_types;
      if (f.sports.length) applies.sports = f.sports;
      if (f.min_age != null) applies.min_age = f.min_age;
      if (f.max_age != null) applies.max_age = f.max_age;
      const body = {
        title: f.title.trim(), classification: f.classification, country: f.country || undefined, region: f.region.trim() || undefined, municipality: f.municipality.trim() || undefined, applies,
        effective_from: f.effective_from, effective_to: f.effective_to || undefined, source_title: f.source_title.trim() || undefined, source_url: f.source_url.trim() || undefined,
        approval_owner: f.approval_owner.trim(), requirements: f.reqs.map(({ key, kind, label, holder, warn_days }) => ({ key, kind, label: label.trim(), holder, warn_days })), waivable: f.waivable, change_note: f.change_note?.trim() || undefined,
      };
      await api.post('/compliance/rules', open.rule
        ? { ...body, rule_id: open.rule.id }
        : { ...body, key: `${(f.country ?? 'xx').toLowerCase()}.${slug(f.title)}-${Math.random().toString(36).slice(2, 6)}`, scope: f.scope, organisation_id: f.scope === 'organisation' ? f.organisation_id : undefined, domains: f.domains, topic: f.topic || slug(f.title) });
      onDone();
    } catch (x) { toast('' + x.message); } finally { setBusy(false); }
  };
  const chips = (list, key, label) => list.map((v) => <Chip key={v} label={label(v)} active={f[key].includes(v)} onPress={() => toggle(key, v)} />);
  return (
    <Sheet visible onClose={onClose} title={open.rule ? 'New version of a rule' : 'Write a rule'}>
      <T size={12} color={c.mute}>Step {step + 1} of 3 · {['What it governs and where', 'Who it applies to', 'When, source and evidence'][step]}</T>
      {step === 0 ? (
        <View style={{ gap: 12 }}>
          <Field label="Name of the rule" value={f.title} onChangeText={(x) => set('title', x)} placeholder="" />
          {!open.rule ? (
            <View style={{ gap: 6 }}>
              <T weight="800" size={13}>Who is it written for?</T>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                {isPlatform ? <Chip label="Platform library" active={f.scope === 'platform'} onPress={() => setF((p) => ({ ...p, scope: 'platform', classification: 'regulatory' }))} /> : null}
                {orgs.map((o) => <Chip key={o.id} label={o.name} active={f.scope === 'organisation' && f.organisation_id === o.id} onPress={() => setF((p) => ({ ...p, scope: 'organisation', organisation_id: o.id, classification: 'organisation_policy' }))} />)}
              </View>
            </View>
          ) : null}
          <View style={{ gap: 6 }}>
            <T weight="800" size={13}>What does it govern?</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{(cat?.domains ?? []).map((x) => <Chip key={x.key} label={x.label} active={f.domains.includes(x.key)} onPress={() => !open.rule && toggle('domains', x.key)} />)}</View>
          </View>
          <View style={{ gap: 6 }}>
            <T weight="800" size={13}>What kind of rule is it?</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{classes.map((k) => <Chip key={k} label={CLASS[k]} active={f.classification === k} onPress={() => set('classification', k)} />)}</View>
            <T size={11.5} color={c.mute}>{f.scope === 'platform' ? 'A law or regulation needs a second person to approve it.' : 'An organisation writes its own policies and contract terms.'}</T>
          </View>
          {!open.rule && rules.length ? (
            <View style={{ gap: 6 }}>
              <T weight="800" size={13}>Is it about the same thing as an existing rule? (optional)</T>
              <T size={11.5} color={c.mute}>Rules about the same thing compete: the stronger one wins. Different things add up.</T>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{rules.slice(0, 12).map((r) => <Chip key={r.id} label={(r.current ?? r.upcoming)?.title ?? r.key} active={f.topic === r.topic} onPress={() => set('topic', f.topic === r.topic ? undefined : r.topic)} />)}</View>
            </View>
          ) : null}
          <CountryPicker label="Country" value={f.country} onChange={(x) => set('country', x || undefined)} optional hint="Leave empty for a rule that applies everywhere." />
          {f.country ? <Field label="State or province (optional)" value={f.region} onChangeText={(x) => set('region', x)} /> : null}
          {f.region ? <Field label="Municipality (optional)" value={f.municipality} onChangeText={(x) => set('municipality', x)} /> : null}
        </View>
      ) : step === 1 ? (
        <View style={{ gap: 12 }}>
          <T size={12} color={c.mute}>Leave a group empty to apply to everyone.</T>
          <View style={{ gap: 6 }}><T weight="800" size={13}>Roles</T><View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{chips(Object.keys(ROLE), 'roles', (v) => ROLE[v])}</View></View>
          <View style={{ gap: 6 }}><T weight="800" size={13}>Kinds of event</T><View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{chips(Object.keys(TYPES), 'event_types', (v) => TYPES[v])}</View></View>
          <SportsMulti label="Sports" value={f.sports} onChange={(v) => set('sports', v)} optional />
          <View style={{ gap: 6 }}>
            <T weight="800" size={13}>Age</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              <Chip label="Any age" active={f.min_age == null && f.max_age == null} onPress={() => setF((p) => ({ ...p, min_age: undefined, max_age: undefined }))} />
              <Chip label="Under 18" active={f.max_age === 17 && f.min_age == null} onPress={() => setF((p) => ({ ...p, min_age: undefined, max_age: 17 }))} />
              <Chip label="Under 16" active={f.max_age === 15 && f.min_age == null} onPress={() => setF((p) => ({ ...p, min_age: undefined, max_age: 15 }))} />
              <Chip label="18 and over" active={f.min_age === 18 && f.max_age == null} onPress={() => setF((p) => ({ ...p, min_age: 18, max_age: undefined }))} />
            </View>
          </View>
        </View>
      ) : (
        <View style={{ gap: 12 }}>
          <DateField label="Takes effect on" value={f.effective_from} onChange={(x) => set('effective_from', x)} />
          <DateField label="Ends on" value={f.effective_to} onChange={(x) => set('effective_to', x)} optional hint="Leave empty if it has no end date." />
          <Field label="Where does it come from?" value={f.source_title} onChangeText={(x) => set('source_title', x)} hint="The law, bylaw, federation rule or contract clause" />
          <Field label="Link to the source (optional)" value={f.source_url} onChangeText={(x) => set('source_url', x)} keyboardType="url" />
          <Field label="Who is accountable for approving it?" value={f.approval_owner} onChangeText={(x) => set('approval_owner', x)} hint="For example: legal counsel, the club board" />
          <T weight="800" size={13}>Evidence it requires</T>
          {f.reqs.map((q, i) => (
            <View key={q.key} style={{ borderWidth: 1, borderColor: c.line, borderRadius: 14, padding: 10, gap: 8 }}>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{Object.entries(KIND).map(([k, l]) => <Chip key={k} label={l} active={q.kind === k} onPress={() => setReq(i, { kind: k })} />)}</View>
              <Field label="What exactly" value={q.label} onChangeText={(x) => setReq(i, { label: x })} />
              <T weight="700" size={12}>Who holds it?</T>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{Object.entries(HOLDER).map(([k, l]) => <Chip key={k} label={l} active={q.holder === k} onPress={() => setReq(i, { holder: k })} />)}</View>
              <Btn small color={c.paper} ink={c.ink} title="Remove" onPress={() => set('reqs', f.reqs.filter((_, j) => j !== i))} style={{ alignSelf: 'flex-start' }} />
            </View>
          ))}
          <Btn small title="+ Add evidence" color={c.violet} onPress={addReq} style={{ alignSelf: 'flex-start' }} />
          {f.classification !== 'legal_mandatory' && f.classification !== 'regulatory' ? (
            <Pressable onPress={() => set('waivable', !f.waivable)} accessibilityRole="switch" accessibilityState={{ checked: f.waivable }} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 }}>
              <View style={{ width: 24, height: 24, borderRadius: 8, borderWidth: 2, borderColor: c.violet, backgroundColor: f.waivable ? c.violet : 'transparent' }} />
              <T style={{ flex: 1 }} size={13.5}>An authorised person may waive it for a limited time</T>
            </Pressable>
          ) : <T size={12} color={c.mute}>A law or regulation can never be waived by a person.</T>}
          {open.rule ? <Field label="What changed? (optional)" value={f.change_note} onChangeText={(x) => set('change_note', x)} /> : null}
        </View>
      )}
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
        {step > 0 ? <Btn title="Back" color={c.paper} ink={c.ink} onPress={() => setStep(step - 1)} style={{ flex: 1 }} /> : null}
        {step < 2 ? <Btn title="Next" onPress={next} style={{ flex: 1 }} /> : <Btn title="Save as draft" onPress={save} loading={busy} style={{ flex: 1 }} />}
      </View>
    </Sheet>
  );
}
