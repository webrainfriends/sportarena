// Open positions: the public job board for tournaments (crew and vendor places). Anyone can browse; applying needs a login.
// Applicants and organisers exchange documents on the application; the organiser accepts and issues a contract, the applicant signs it.
import { docMaxMb } from '../upload-limits';
import React, { useRef, useState } from 'react';
import { Platform, View } from 'react-native';
import { api } from '../api';
import { openProtected } from '../open-file';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Btn, Card, Chip, Empty, ErrorBox, Field, H1, Loading, Row, Screen, Seg, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { pickDocument } from './insurance';
import { CoachRequestList } from './coaching';
import { setIntent } from '../market/intent';
import { c, day } from '../theme';
import { moneyIn } from '../vtime';

export const ROLE_META = {
  referee: ['🟨', 'Referee'], umpire: ['🧑‍⚖️', 'Umpire'], linesman: ['🚩', 'Linesman'], scorer: ['📝', 'Scorer'], doctor: ['🩺', 'Doctor'], physio: ['💆', 'Physio'], medic: ['⛑️', 'Medic'],
  volunteer: ['🙋', 'Volunteer'], security: ['🛡️', 'Security'], other: ['🔧', 'Other'], retail: ['🛍️', 'Retail stall'], catering: ['🍽️', 'Catering'], vendor: ['🏪', 'Vendor'],
};
export const STATUS = {
  invited: ['Offer for you', c.sunSoft], applied: ['Applied', c.cyanSoft], contract_sent: ['Contract to sign', c.sunSoft], accepted: ['Confirmed', c.limeSoft],
  rejected: ['Not taken forward', c.violetSoft], declined: ['Declined', c.violetSoft], withdrawn: ['Withdrawn', c.violetSoft], released: ['Released', c.violetSoft], completed: ['Done', c.limeSoft],
};
const when = (v) => new Date(v).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const dates = (p) => (p.starts_on ? `${when(p.starts_on)}${p.ends_on && String(p.ends_on).slice(0, 10) !== String(p.starts_on).slice(0, 10) ? ` – ${when(p.ends_on)}` : ''}` : 'Dates to be announced');
const feeLine = (p) => (p.fee_cents > 0 ? (p.pay_direction === 'applicant_pays' ? `Stall fee ${moneyIn(p.fee_cents, p.currency)}` : `Pays ${moneyIn(p.fee_cents, p.currency)}`) : p.pay_direction === 'applicant_pays' ? 'No stall fee' : 'Unpaid');

// ---------------------------------------------------------------------------------------------------------- documents
/** The documents exchanged on one application: both the organiser and the applicant add and read them. */
export function PositionDocs({ assignmentId, title, onClose, onChanged }) {
  const { user, toast } = useSession();
  const docs = useLoad(() => api.get(`/staff-assignments/${assignmentId}/documents`), [assignmentId]);
  const [name, setName] = useState(''), [busy, setBusy] = useState(false);
  const add = async () => {
    const f = await pickDocument();
    if (!f) return;
    setBusy(true);
    try { await api.upload(`/staff-assignments/${assignmentId}/documents`, f.blob, { title: name.trim() || (f.name ?? '').slice(0, 120) || 'Document' }); setName(''); await docs.reload(); onChanged?.(); toast('Document shared'); }
    catch (e) { toast(e.message); } finally { setBusy(false); }
  };
  const open = async (d) => {
    try {
      await openProtected(`/staff-documents/${d.id}/file`, d.file_name ?? `document-${d.id}`);
    } catch (e) { toast(e.message); }
  };
  const remove = async (d) => { try { await api.del(`/staff-documents/${d.id}`); await docs.reload(); onChanged?.(); } catch (e) { toast(e.message); } };
  return (
    <Sheet visible onClose={onClose} title={title ?? 'Documents'}>
      <T size={12} color={c.mute}>Share licences, certificates, insurance, menus, briefs — anything the other side needs. PDF or photo, up to {docMaxMb()} MB. Only you and the other party can open them; files are encrypted. Removing one only hides it.</T>
      {docs.loading ? <Loading /> : docs.error ? <ErrorBox error={docs.error} onRetry={docs.reload} /> : docs.data?.length ? docs.data.map((d) => (
        <Card key={d.id} pad={12}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <T size={22}>{d.content_type === 'application/pdf' ? '📄' : '🖼️'}</T>
            <View style={{ flex: 1 }}><T weight="700">{d.title}</T><T size={12} color={c.mute}>{Math.max(1, Math.round(d.size_bytes / 1024))} KB · {day(d.created_at)} · {d.uploaded_by === user.id ? 'you' : d.uploaded_by_name}</T></View>
          </View>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
            <Btn small title="Open" color={c.violet} onPress={() => open(d)} />
            {d.uploaded_by === user.id ? <Btn small title="Remove" color={c.paper} ink={c.red} onPress={() => remove(d)} /> : null}
          </View>
        </Card>
      )) : <Empty emoji="🗂️" title="No documents yet" sub="Add the first one for the other side to read." />}
      <View style={{ gap: 8 }}>
        <T weight="800" size={13}>Add a document</T>
        <Field value={name} onChangeText={setName} placeholder="Name (optional)" />
        <Btn title="Choose a file" onPress={add} loading={busy} />
      </View>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------------------------------------- contract
export function ContractSheet({ id, onClose, onChanged }) {
  const { toast } = useSession();
  const k = useLoad(() => api.get(`/event-contracts/${id}`), [id]);
  const [busy, setBusy] = useState(false);
  const d = k.data;
  const answer = async (accept) => {
    setBusy(true);
    try { await api.post(`/event-contracts/${id}/respond`, { accept }); toast(accept ? 'Contract accepted — you are confirmed' : 'Contract declined'); onChanged?.(); onClose(); }
    catch (e) { toast(e.message); } finally { setBusy(false); }
  };
  return (
    <Sheet visible onClose={onClose} title="Contract">
      {k.loading ? <Loading /> : k.error ? <ErrorBox error={k.error} onRetry={k.reload} /> : (
        <>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            <Tag label={d.status === 'pending' ? 'Waiting for signature' : d.status === 'signed' ? 'Signed by both' : d.status} color={d.status === 'signed' ? c.limeSoft : c.sunSoft} />
            <Tag label={`${d.organiser_name} signed ${day(d.organiser_signed_at)}`} />{d.party_signed_at ? <Tag label={`${d.party_name} signed ${day(d.party_signed_at)}`} /> : null}
          </View>
          <Card pad={14}><T size={13} style={{ lineHeight: 20 }} selectable>{d.body}</T></Card>
          {d.mine_to_sign ? (
            <View style={{ gap: 8 }}>
              <T size={12} color={c.mute}>Accepting is your electronic signature and confirms your place.</T>
              <View style={{ flexDirection: 'row', gap: 8 }}><Btn title="Accept & sign" color={c.lime} onPress={() => answer(true)} loading={busy} /><Btn title="Decline" color={c.paper} ink={c.red} onPress={() => answer(false)} /></View>
            </View>
          ) : null}
        </>
      )}
    </Sheet>
  );
}

// ---------------------------------------------------------------------------------------------------------- apply
const ROLE_STRENGTHS = {
  referee:   ['Rules mastery', 'Pressure composure', 'Decisive calls', 'Multilingual', 'Multi-sport', 'High-level experience', 'Youth tournaments', 'International finals', 'VAR / tech-assisted', 'Excellent fitness', 'Leadership', 'Communication'],
  umpire:    ['Rules mastery', 'Pressure composure', 'Decisive calls', 'Multilingual', 'Multi-sport', 'High-level experience', 'Youth tournaments', 'International finals', 'Excellent fitness', 'Leadership', 'Communication'],
  linesman:  ['Quick reactions', 'Positional awareness', 'Flag discipline', 'Communication', 'Multilingual', 'Excellent fitness', 'Multi-sport', 'High-level experience'],
  scorer:    ['Attention to detail', 'Technology proficient', 'Fast data entry', 'Multi-sport', 'Bilingual', 'Live broadcast liaison', 'Spreadsheet / software', 'Accuracy under pressure'],
  doctor:    ['Sports medicine', 'Emergency care', 'Fracture management', 'Concussion protocol', 'Doping control', 'Paediatric care', 'Multi-sport', 'International events', 'On-field first aid', 'Full medical kit', 'Ambulance access'],
  physio:    ['Injury rehab', 'On-field assessment', 'Sports taping', 'Post-match recovery', 'Multi-sport', 'On-site equipment', 'Manual therapy', 'Exercise prescription'],
  medic:     ['Emergency care', 'On-field first aid', 'Ambulance access', 'Fracture management', 'Concussion protocol', 'Defibrillator certified', 'Paediatric care', 'Multi-sport'],
  volunteer: ['Enthusiastic', 'Multilingual', 'People person', 'Physically fit', 'First aid trained', 'Events experience', 'Child safeguarding', 'Adaptable', 'Team player', 'Own transport'],
  security:  ['Crowd management', 'First aid trained', 'Communication', 'De-escalation', 'SIA licensed', 'Multi-event experience', 'Bomb threat protocol', 'VIP security', 'CCTV monitoring'],
  assessor:  ['Attention to detail', 'Technical knowledge', 'Impartiality', 'Report writing', 'Multi-sport', 'Coaching experience', 'Data proficiency'],
  retail:    ['Premium product', 'Award-winning', 'Established brand', 'Pop-up specialist', 'Own payment terminal', 'Eco-friendly packaging', 'Instagram-worthy'],
  catering:  ['Health-conscious range', 'Youth/kids friendly', 'Vegan/vegetarian', 'Allergy-aware', 'Award-winning', 'Own payment terminal', 'Eco-friendly packaging', 'Licensed to sell alcohol', 'Instagram-worthy'],
  vendor:    ['Premium product', 'Established brand', 'Pop-up specialist', 'Own payment terminal', 'Eco-friendly packaging', 'Award-winning'],
};
const OFFICIAL_ROLES = new Set(['referee', 'umpire', 'linesman', 'scorer', 'doctor', 'physio', 'medic', 'assessor', 'security']);
const VENDOR_ROLE_SET = new Set(['retail', 'catering', 'vendor']);
const EXP_OPTS = [
  { value: 'first_time', label: 'First event' },
  { value: 'some', label: 'Some experience' },
  { value: 'experienced', label: 'Regularly active' },
  { value: 'expert', label: 'Professional / elite' },
];
const TRANSPORT_OPTS = [
  { value: 'own_vehicle', label: 'Own vehicle' },
  { value: 'public_transport', label: 'Public transport' },
  { value: 'any', label: 'Either' },
];
const PROD_OPTS = [
  { value: 'retail', label: 'Retail & merchandise' },
  { value: 'food', label: 'Food' },
  { value: 'beverage', label: 'Beverages' },
  { value: 'services', label: 'Services' },
];

function ApplySheet({ p, onClose, onApplied }) {
  const [sent, setSent] = useState(null);
  const done = useRef(false);
  if (sent) return <PositionDocs assignmentId={sent} title="Add documents for the organiser" onClose={() => { onClose(); onApplied?.(); }} />;
  const vendor = p.pay_direction === 'applicant_pays';
  const strengths = ROLE_STRENGTHS[p.role] ?? ROLE_STRENGTHS.volunteer;
  const isOfficial = OFFICIAL_ROLES.has(p.role);
  const isVendor = VENDOR_ROLE_SET.has(p.role);
  return (
    <FormSheet visible onClose={() => { if (!done.current) onClose(); }}
      title={`Apply · ${p.title || ROLE_META[p.role]?.[1]}`} submitLabel="Send application"
      fields={[
        { key: '_ctx', type: 'section', label: `${p.event_name} · ${dates(p)} · ${feeLine(p)}${p.requirements ? `\n\n📋 Requirements: ${p.requirements}` : ''}` },
        { key: 'message', label: 'Cover statement', type: 'multiline', optional: !isOfficial, placeholder: "Describe your relevant experience, why you're the right person for this event, and what you bring to the team…", hint: 'Your GotMyGame profile, performance record and ratings are shared with the organiser.' },
        { key: '_strengths_hdr', type: 'section', label: 'What you bring' },
        { key: 'strengths', label: 'Key strengths', type: 'multi', optional: true, options: strengths },
        { key: '_exp_hdr', type: 'section', label: 'Experience' },
        { key: 'experience_level', label: 'Experience level', type: 'chips', optional: true, options: EXP_OPTS },
        { key: 'years_active', label: 'Years in this role', type: 'stepper', min: 0, max: 50, default: 0, suffix: ' yr', show: (v) => v.experience_level && v.experience_level !== 'first_time' },
        ...(isOfficial ? [
          { key: '_cred_hdr', type: 'section', label: 'Credentials' },
          { key: 'has_qualification', label: 'I hold a valid licence / certification', type: 'switch', hint: 'Officials and crew with verified credentials are highlighted on your application.' },
          { key: 'qualification_body', label: 'Issuing body / governing body', optional: true, show: (v) => v.has_qualification, placeholder: 'e.g. BCCI, FIFA, World Athletics…' },
          { key: 'qualification_level', label: 'Grade / badge / licence level', optional: true, show: (v) => v.has_qualification, placeholder: 'e.g. Level 2 — State Panel' },
          { key: 'qualification_ref', label: 'Licence reference number', optional: true, show: (v) => v.has_qualification, placeholder: 'Optional — the reference on your certificate' },
          { key: 'qualification_expires', label: 'Expiry date', type: 'date', optional: true, show: (v) => v.has_qualification },
        ] : []),
        ...(isVendor ? [
          { key: '_vendor_hdr', type: 'section', label: 'Stall details' },
          { key: 'stall_name', label: 'Trading / stall name', placeholder: 'Your brand or trading name' },
          { key: 'product_category', label: 'Category', type: 'chips', options: PROD_OPTS },
          { key: 'products_desc', label: "What you're selling", type: 'multiline', placeholder: 'List your main items, any awards, allergen policy, preparation style…' },
          { key: 'stall_width_m', label: 'Stall width (metres)', type: 'stepper', min: 2, max: 12, default: 3, step: 1, suffix: ' m' },
          { key: 'power_needed', label: "I'll need power at the stall", type: 'switch' },
          { key: 'power_amps', label: 'Power requirement (amps)', type: 'stepper', min: 5, max: 100, default: 15, step: 5, suffix: ' A', show: (v) => v.power_needed },
          { key: 'food_cert', label: 'Food safety certificate number', optional: true, placeholder: 'e.g. FSSAI/MH/2024/00001', show: (v) => ['food', 'beverage'].includes(v.product_category) },
        ] : []),
        { key: '_logistics_hdr', type: 'section', label: 'Availability & logistics' },
        { key: 'confirms_dates', label: `Available for all event dates (${dates(p)})`, type: 'switch', default: true },
        { key: 'transport', label: 'How will you get there?', type: 'chips', optional: true, options: TRANSPORT_OPTS },
        { key: 'accommodation_needed', label: "I'll need accommodation at the venue", type: 'switch' },
        { key: '_fee_hdr', type: 'section', label: vendor ? 'Stall fee' : 'Fee' },
        { key: 'fee', label: vendor ? 'Stall fee you offer' : 'Your fee, if different', type: 'money', currency: p.currency, optional: true, hint: p.fee_cents > 0 ? `Posted rate is ${feeLine(p)}. Leave blank to accept it, or enter your preferred fee.` : 'No fee posted — enter one if you expect to be paid.' },
        { key: '_add_hdr', type: 'section', label: 'Additional information' },
        { key: 'additional', label: 'Anything else the organiser should know', type: 'multiline', optional: true, placeholder: 'Kit colour preference, dietary requirements, specific availability notes…' },
      ]}
      onSubmit={async (v) => {
        const appData = {};
        if (v.strengths?.length) appData.strengths = v.strengths;
        if (v.experience_level) appData.experience_level = v.experience_level;
        if (v.years_active) appData.years_active = v.years_active;
        if (v.has_qualification) {
          appData.has_qualification = true;
          if (v.qualification_body) appData.qualification_body = v.qualification_body;
          if (v.qualification_level) appData.qualification_level = v.qualification_level;
          if (v.qualification_ref) appData.qualification_ref = v.qualification_ref;
          if (v.qualification_expires) appData.qualification_expires = v.qualification_expires;
        }
        if (v.confirms_dates !== undefined) appData.confirms_dates = v.confirms_dates;
        if (v.transport) appData.transport = v.transport;
        if (v.accommodation_needed) appData.accommodation_needed = v.accommodation_needed;
        if (isVendor) {
          if (v.stall_name) appData.stall_name = v.stall_name;
          if (v.product_category) appData.product_category = v.product_category;
          if (v.products_desc) appData.products_desc = v.products_desc;
          if (v.stall_width_m) appData.stall_width_m = v.stall_width_m;
          if (v.power_needed) appData.power_needed = v.power_needed;
          if (v.power_amps) appData.power_amps = v.power_amps;
          if (v.food_cert) appData.food_cert = v.food_cert;
        }
        if (v.additional) appData.additional = v.additional;
        const a = await api.post(`/staff-roles/${p.id}/apply`, {
          message: v.message || undefined,
          fee_cents: v.fee || undefined,
          application_data: Object.keys(appData).length ? appData : undefined,
        });
        done.current = true; setSent(a.id);
        return 'Application sent — add any documents the organiser should see';
      }} />
  );
}

// ---------------------------------------------------------------------------------------------------------- the board
export function PositionCard({ p, onApply, onOpenMine }) {
  const [icon, label] = ROLE_META[p.role] ?? ROLE_META.other;
  const vendor = p.pay_direction === 'applicant_pays';
  const mine = p.my_status && STATUS[p.my_status];
  return (
    <View style={{ backgroundColor: c.paper, borderRadius: 20, borderWidth: 1, borderColor: c.line, padding: 14, gap: 10, shadowColor: '#0F172A', shadowOpacity: 0.06, shadowRadius: 14, shadowOffset: { width: 0, height: 6 } }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View style={{ width: 46, height: 46, borderRadius: 14, backgroundColor: vendor ? c.sunSoft : c.pinkSoft, alignItems: 'center', justifyContent: 'center' }}><T size={24}>{icon}</T></View>
        <View style={{ flex: 1 }}>
          <T weight="800" size={16} numberOfLines={2}>{p.title || label}</T>
          <T size={12} color={c.mute} numberOfLines={1}>{p.banner_emoji} {p.event_name}</T>
        </View>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {p.sport ? <Tag label={`${p.sport_emoji ?? ''} ${p.sport}`} /> : null}
        {p.city ? <Tag label={`📍 ${p.city}`} /> : null}
        <Tag label={`🗓️ ${dates(p)}`} />
        <Tag label={`👥 ${p.open_places} of ${p.needed} open`} />
        <Tag label={`💰 ${feeLine(p)}`} color={c.limeSoft} />
        {vendor ? <Tag label="Vendor place" color={c.sunSoft} /> : null}
      </View>
      {p.notes ? <T size={13} color="#334155" numberOfLines={3}>{p.notes}</T> : null}
      <T size={12} color={c.mute}>Organised by {p.organiser_name}</T>
      {p.is_mine ? <T size={12} color={c.mute} weight="600">Your event — manage applicants in the tournament console.</T>
        : mine ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><Tag label={mine[0]} color={mine[1]} />{onOpenMine ? <Btn small title="Open" color={c.paper} ink={c.ink} onPress={onOpenMine} /> : null}</View>
        : <Btn small title="Apply" onPress={() => onApply(p)} style={{ alignSelf: 'flex-start' }} />}
    </View>
  );
}

/**
 * The board itself — used on the public landing page, the member feed and the Openings screen.
 * `openAuth(intent)` is the landing page's sign-in flow; signed-in members apply straight away.
 */
export function OpenPositions({ openAuth, onChanged, limit = 12, compact, onSeeAll, columns = 1, onOpenMine }) {
  const { user } = useSession();
  const [group, setGroup] = useState(null), [q, setQ] = useState(''), [applying, setApplying] = useState(null);
  const list = useLoad(() => api.get('/open-positions', { group: group ?? undefined, q: q.trim() || undefined, limit }), [group, q, user?.id]);
  const rows = list.data ?? [];
  const apply = (p) => {
    if (!user) { const intent = { action: 'apply_position', positionId: p.id, title: p.title || ROLE_META[p.role]?.[1] }; setIntent(intent); openAuth?.(intent); return; }
    setApplying(p);
  };
  if (compact && !list.loading && !rows.length) return null;
  return (
    <View style={{ gap: 12 }}>
      {compact ? null : (
        <>
          <Seg options={[{ value: null, label: 'All' }, { value: 'crew', label: '🟨 Crew & officials' }, { value: 'vendor', label: '🛍️ Vendors & stalls' }]} value={group} onChange={setGroup} color={c.pink} />
          <Field value={q} onChangeText={setQ} placeholder="Search by role, event or city…" />
        </>
      )}
      {list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : list.loading && !list.data ? <Loading /> : rows.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 14 }}>
          {rows.map((p) => <View key={p.id} style={{ flexGrow: 1, flexBasis: columns > 1 ? 300 : '100%', minWidth: 0, maxWidth: columns > 1 ? 420 : undefined }}><PositionCard p={p} onApply={apply} onOpenMine={onOpenMine} /></View>)}
        </View>
      ) : <Empty emoji="💼" title="No open positions" sub={q || group ? 'Nothing matches that search — try clearing it.' : 'When organisers open referee, security, volunteer or vendor places they appear here.'} />}
      {onSeeAll && rows.length ? <Btn small title="See all open positions" color={c.paper} ink={c.pink} onPress={onSeeAll} style={{ alignSelf: 'flex-start' }} /> : null}
      {applying ? <ApplySheet p={applying} onClose={() => setApplying(null)} onApplied={() => { list.reload(); onChanged?.(); }} /> : null}
    </View>
  );
}

/** Used after sign-in to finish an application the visitor started on the public page. */
export function ResumeApply({ positionId, onDone }) {
  const p = useLoad(() => api.get(`/open-positions/${positionId}`), [positionId]);
  if (!p.data) return null;
  if (p.data.my_status || p.data.is_mine) { onDone(); return null; }
  return <ApplySheet p={p.data} onClose={onDone} onApplied={onDone} />;
}

// ---------------------------------------------------------------------------------------------------------- my side
function MyApplications() {
  const { toast } = useSession();
  const list = useLoad(() => api.get('/me/staff-assignments', { limit: 100 }), []);
  const [docs, setDocs] = useState(null), [contract, setContract] = useState(null);
  const act = async (fn, msg) => { try { await fn(); toast(msg); list.reload(); } catch (e) { toast(e.message); } };
  const rows = list.data ?? [];
  return (
    <>
      {list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !list.data ? <Loading /> : rows.length ? rows.map((a) => {
        const [icon, label] = ROLE_META[a.role] ?? ROLE_META.other, st = STATUS[a.status] ?? [a.status, c.violetSoft];
        const live = ['applied', 'contract_sent', 'accepted', 'invited'].includes(a.status);
        return (
          <Card key={a.id} pad={14}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <T size={26}>{icon}</T>
              <View style={{ flex: 1 }}><T weight="800">{a.title || label}</T><T size={12} color={c.mute}>{a.event_name} · {dates(a)}{a.fee_cents > 0 ? ` · ${moneyIn(a.fee_cents, a.currency)}` : ''}</T></View>
              <Tag label={st[0]} color={st[1]} />
            </View>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
              {a.status === 'invited' ? <><Btn small title="Accept" color={c.lime} onPress={() => act(() => api.post(`/staff-assignments/${a.id}/respond`, { accept: true }), 'Accepted')} /><Btn small title="Decline" color={c.paper} ink={c.red} onPress={() => act(() => api.post(`/staff-assignments/${a.id}/respond`, { accept: false }), 'Declined')} /></> : null}
              {a.contract_id ? <Btn small title={a.status === 'contract_sent' ? 'Review & sign contract' : 'View contract'} color={a.status === 'contract_sent' ? c.lime : c.paper} ink={a.status === 'contract_sent' ? '#fff' : c.ink} onPress={() => setContract(a.contract_id)} /> : null}
              {live ? <Btn small title={`Documents${a.documents ? ` (${a.documents})` : ''}`} color={c.violet} onPress={() => setDocs(a)} /> : null}
              {['applied', 'contract_sent', 'accepted'].includes(a.status) ? <Btn small title={a.status === 'accepted' ? 'Withdraw' : 'Withdraw application'} color={c.paper} ink={c.red} onPress={() => act(() => api.post(`/staff-assignments/${a.id}/end`, {}), 'Withdrawn')} /> : null}
            </View>
          </Card>
        );
      }) : <Empty emoji="📨" title="No applications yet" sub="Apply to an open position and track the organiser's answer, documents and contract here." />}
      {docs ? <PositionDocs assignmentId={docs.id} title={`${docs.event_name} · documents`} onClose={() => setDocs(null)} onChanged={list.reload} /> : null}
      {contract ? <ContractSheet id={contract} onClose={() => setContract(null)} onChanged={list.reload} /> : null}
    </>
  );
}

export function Openings() {
  const { user } = useSession();
  const nav = useNav();
  const [tab, setTab] = useState('browse');
  const [key, setKey] = useState(0);
  return (
    <Screen wide>
      <H1>Open positions</H1>
      {user?.roles?.some((r) => ['referee', 'organizer', 'admin'].includes(r)) ? <Btn small title="🧮 Official scoring: proposals awaiting my review" color={c.violet} onPress={() => nav.push('ScoringTool', { tab: 'awaiting' })} style={{ alignSelf: 'flex-start', marginTop: 6 }} /> : null}
      {user?.roles?.includes('referee') ? <Btn small title="🏅 My officiating development: grade, assessments & CPD" color={c.paper} ink={c.ink} onPress={() => nav.push('OfficialsDevelopment')} style={{ alignSelf: 'flex-start', marginTop: 6 }} /> : null}
      <T color={c.mute} style={{ marginTop: 4 }}>Referees, scorers, doctors, volunteers, security, stalls and caterers wanted by tournaments, and athletes, groups, teams and events looking for a coach. Apply or answer, share documents and sign the contract here.</T>
      <View style={{ marginVertical: 10 }}><Seg options={[{ value: 'browse', label: 'Browse' }, { value: 'coaching', label: 'Coaching requests' }, { value: 'mine', label: 'My applications' }]} value={tab} onChange={setTab} color={c.pink} /></View>
      {tab === 'coaching' ? (user ? <CoachRequestList defaultAll /> : <T color={c.mute}>Sign in to see athletes, groups, teams and events looking for a coach.</T>) : null}
      {tab === 'browse' ? <OpenPositions key={key} columns={2} onChanged={() => setKey((k) => k + 1)} onOpenMine={() => setTab('mine')} /> : null}
      {tab === 'mine' && user ? <MyApplications /> : null}
    </Screen>
  );
}
