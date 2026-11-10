// Open positions: the public job board for tournaments (crew and vendor places). Anyone can browse; applying needs a login.
// Applicants and organisers exchange documents on the application; the organiser accepts and issues a contract, the applicant signs it.
import { docMaxMb } from '../upload-limits';
import React, { useRef, useState } from 'react';
import { Platform, View } from 'react-native';
import { api } from '../api';
import { openPdf, openProtected } from '../open-file';
import { MenuField } from '../menu-field';
import { t } from '../i18n';
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
const DOC_KINDS = ['licence', 'certificate', 'insurance', 'identity', 'food_safety', 'price_list', 'brief', 'other'];
const DOC_ACCEPT = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Choose one or several PDFs or photos. Web: the file dialog; iOS, iPadOS and Android: the Files picker. Resolves [{ blob, name, size }] ([] when cancelled). */
export async function pickDocuments() {
  if (Platform.OS === 'web') {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file'; input.multiple = true; input.accept = DOC_ACCEPT.join(',');
      input.onchange = () => resolve([...(input.files ?? [])].map((f) => ({ blob: f, name: f.name, size: f.size })));
      input.oncancel = () => resolve([]);
      input.click();
    });
  }
  const DocumentPicker = await import('expo-document-picker');
  const r = await DocumentPicker.getDocumentAsync({ type: DOC_ACCEPT, multiple: true, copyToCacheDirectory: true });
  if (r.canceled || !r.assets?.length) return [];
  return Promise.all(r.assets.map(async (x) => ({ blob: await (await fetch(x.uri)).blob(), name: x.name, size: x.size ?? 0 })));
}

/** The documents exchanged on one application: both the organiser and the applicant add and read them. Several files can be added in one go. */
export function PositionDocs({ assignmentId, title, onClose, onChanged }) {
  const { user, toast } = useSession();
  const docs = useLoad(() => api.get(`/staff-assignments/${assignmentId}/documents`), [assignmentId]);
  const [kind, setKind] = useState('licence'), [name, setName] = useState(''), [busy, setBusy] = useState(false);
  const [queue, setQueue] = useState([]); // this visit's uploads: { name, size, state: 'waiting' | 'sending' | 'done' | 'failed', error }
  const maxBytes = docMaxMb() * 1048576;
  const add = async () => {
    let files;
    try { files = await pickDocuments(); } catch (e) { toast(e.message); return; }
    if (!files.length) return;
    const start = queue.length;
    setQueue((q) => [...q, ...files.map((f) => ({ name: f.name, size: f.size, state: f.size > maxBytes ? 'failed' : 'waiting', error: f.size > maxBytes ? t('posapp.docs.too_big', { mb: docMaxMb() }) : null }))]);
    setBusy(true);
    let sent = 0;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (f.size > maxBytes) continue;
      const mark = (patch) => setQueue((q) => q.map((x, j) => (j === start + i ? { ...x, ...patch } : x)));
      mark({ state: 'sending' });
      const label = (files.length === 1 && name.trim()) || (f.name ?? '').replace(/\.[A-Za-z0-9]+$/, '');
      try {
        await api.upload(`/staff-assignments/${assignmentId}/documents`, f.blob, { title: `${t(`posapp.kind.${kind}`)} · ${label || t('posapp.docs.untitled')}`.slice(0, 120) });
        mark({ state: 'done' }); sent += 1;
      } catch (e) { mark({ state: 'failed', error: e.message }); }
    }
    setBusy(false); setName('');
    if (sent) { await docs.reload(); onChanged?.(); toast(t('posapp.docs.shared', { n: sent })); }
  };
  const open = async (d) => { try { await openProtected(`/staff-documents/${d.id}/file`, d.file_name ?? `document-${d.id}`); } catch (e) { toast(e.message); } };
  const remove = async (d) => { try { await api.del(`/staff-documents/${d.id}`); await docs.reload(); onChanged?.(); } catch (e) { toast(e.message); } };
  const rows = docs.data ?? [];
  const total = rows.reduce((n, d) => n + Number(d.size_bytes ?? 0), 0);
  const STATE = { waiting: [t('posapp.docs.waiting'), c.violetSoft], sending: [t('posapp.docs.sending'), c.cyanSoft], done: [t('posapp.docs.sent'), c.limeSoft], failed: [t('posapp.docs.failed'), c.sunSoft] };
  return (
    <Sheet visible onClose={onClose} title={title ?? t('posapp.docs.title')}
      footer={<><T size={12} color={c.mute} style={{ flex: 1 }}>{busy ? t('posapp.docs.uploading') : t('posapp.docs.saved_note')}</T><Btn title={t('common.done')} onPress={onClose} disabled={busy} style={{ minHeight: 44, minWidth: 110 }} accessibilityLabel={t('posapp.docs.done_a11y')} /></>}>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {[[rows.length, t('posapp.docs.m_files')], [MAX_DOCS - rows.length, t('posapp.docs.m_left')], [rows.length ? kb(total) : '—', t('posapp.docs.m_size')]].map(([v, label]) => (
          <View key={label} style={{ flex: 1, backgroundColor: c.paper, borderRadius: 14, borderWidth: 1, borderColor: c.line, paddingVertical: 10, paddingHorizontal: 12 }}>
            <T weight="800" size={18}>{v}</T><T size={11} color={c.mute} weight="600">{label}</T>
          </View>
        ))}
      </View>
      <T size={12} color={c.mute}>{t('posapp.docs.intro', { mb: docMaxMb() })}</T>

      <Card pad={14}>
        <View style={{ gap: 10 }}>
          <T weight="800" size={14}>{t('posapp.docs.add_title')}</T>
          <MenuField label={t('posapp.docs.kind')} value={kind} onChange={setKind} options={DOC_KINDS.map((k) => ({ value: k, label: t(`posapp.kind.${k}`) }))} />
          <Field label={t('posapp.docs.name')} value={name} onChangeText={setName} placeholder={t('posapp.docs.name_ph')} />
          <Btn title={t('posapp.docs.choose')} onPress={add} loading={busy} disabled={rows.length >= MAX_DOCS} style={{ minHeight: 48 }} />
          <T size={11} color={c.mute}>{t('posapp.docs.choose_hint')}</T>
          {queue.length ? <View style={{ gap: 6 }}>{queue.map((x, i) => (
            <View key={`${x.name}${i}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <View style={{ flex: 1 }}><T size={13} weight="700" numberOfLines={1}>{x.name}</T>{x.error ? <T size={11} color={c.red}>{x.error}</T> : <T size={11} color={c.mute}>{kb(x.size)}</T>}</View>
              <Tag label={STATE[x.state][0]} color={STATE[x.state][1]} />
            </View>
          ))}</View> : null}
        </View>
      </Card>

      <T weight="800" size={14}>{t('posapp.docs.on_file', { n: rows.length })}</T>
      {docs.loading && !docs.data ? <Loading /> : docs.error ? <ErrorBox error={docs.error} onRetry={docs.reload} /> : rows.length ? rows.map((d) => (
        <Card key={d.id} pad={12}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: c.pinkSoft, alignItems: 'center', justifyContent: 'center' }}><T size={20}>{d.content_type === 'application/pdf' ? '📄' : '🖼️'}</T></View>
            <View style={{ flex: 1 }}><T weight="700" numberOfLines={2}>{d.title}</T><T size={12} color={c.mute}>{kb(d.size_bytes)} · {day(d.created_at)} · {d.uploaded_by === user.id ? t('posapp.docs.by_you') : d.uploaded_by_name}</T></View>
            <Btn small title={t('posapp.docs.open')} color={c.violet} onPress={() => open(d)} style={{ minHeight: 44 }} />
            {d.uploaded_by === user.id ? <Btn small title={t('posapp.docs.remove')} color={c.paper} ink={c.red} onPress={() => remove(d)} style={{ minHeight: 44 }} /> : null}
          </View>
        </Card>
      )) : <Empty emoji="🗂️" title={t('posapp.docs.none')} sub={t('posapp.docs.none_sub')} />}
    </Sheet>
  );
}
const MAX_DOCS = 30;

// ---------------------------------------------------------------------------------------------------------- the submitted application, in full
const STEPS = ['applied', 'contract_sent', 'accepted', 'completed'];
const Pair = ({ label, children }) => (
  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, paddingVertical: 8, borderBottomWidth: 1, borderColor: c.line }}>
    <T size={12} color={c.mute} weight="700" style={{ flexBasis: 150, flexGrow: 1 }}>{label}</T>
    <T size={14} style={{ flexBasis: 200, flexGrow: 2 }}>{children}</T>
  </View>
);
const answer = (r) => (typeof r.value === 'boolean' ? t(r.value ? 'posapp.yes' : 'posapp.no') : ['experience_level', 'transport', 'product_category'].includes(r.key) ? t(`posapp.v.${r.key}.${r.value}`) : r.text);

/** Everything that was submitted on one application, as the form laid it out, with the documents, the progress and a PDF to keep. */
export function ApplicationSheet({ id, onClose, onDocs }) {
  const { toast } = useSession();
  const q = useLoad(() => api.get(`/staff-assignments/${id}/application`), [id]);
  const [busy, setBusy] = useState(false);
  const a = q.data;
  const pdf = async () => { setBusy(true); try { await openPdf(`/staff-assignments/${id}/application.pdf`, `application-${a.reference}`); } catch (e) { toast(e.message); } finally { setBusy(false); } };
  const at = a ? STEPS.indexOf(a.status) : -1;
  return (
    <Sheet visible onClose={onClose} title={t('posapp.title')}
      footer={a ? <><Btn title={t('posapp.pdf')} onPress={pdf} loading={busy} style={{ flex: 1, minHeight: 48 }} accessibilityLabel={t('posapp.pdf_a11y')} /><Btn title={t('common.close')} color={c.paper} ink={c.ink} onPress={onClose} style={{ minHeight: 48, minWidth: 96 }} /></> : null}>
      {q.error ? <ErrorBox error={q.error} onRetry={q.reload} /> : !a ? <Loading /> : (
        <>
          <View style={{ gap: 4 }}>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              <Tag label={(STATUS[a.status] ?? [a.status_label])[0]} color={(STATUS[a.status] ?? [null, c.violetSoft])[1]} />
              <Tag label={a.reference} color={c.violetSoft} />
              <Tag label={t('posapp.submitted', { d: day(a.submitted_at) })} color={c.paper} />
            </View>
            <T weight="800" size={22} style={{ letterSpacing: -0.4 }}>{a.position.title}</T>
            <T size={13} color={c.mute}>{[a.event.name, a.event.city, a.event.dates].filter(Boolean).join(' · ')}</T>
          </View>

          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {[[a.fee.posted, t(a.fee.vendor ? 'posapp.m_stall_fee' : 'posapp.m_posted')], [a.fee.proposed ?? t('posapp.as_posted'), t('posapp.m_yours')], [a.documents.length, t('posapp.m_docs')], [a.contract ? t(`posapp.contract.${a.contract.status}`) : t('posapp.contract.none'), t('posapp.m_contract')]].map(([v, label]) => (
              <View key={label} style={{ flexGrow: 1, flexBasis: 120, backgroundColor: c.paper, borderRadius: 14, borderWidth: 1, borderColor: c.line, paddingVertical: 10, paddingHorizontal: 12 }}>
                <T weight="800" size={16} numberOfLines={1}>{v}</T><T size={11} color={c.mute} weight="600">{label}</T>
              </View>
            ))}
          </View>

          {at >= 0 ? (
            <View accessibilityLabel={t('posapp.progress_a11y', { step: t(`posapp.step.${a.status}`) })} style={{ flexDirection: 'row', gap: 6 }}>
              {STEPS.map((st, i) => (
                <View key={st} style={{ flex: 1, gap: 4 }}>
                  <View style={{ height: 6, borderRadius: 3, backgroundColor: i <= at ? c.pink : c.line }} />
                  <T size={11} weight={i === at ? '800' : '600'} color={i <= at ? c.ink : c.mute} numberOfLines={2}>{t(`posapp.step.${st}`)}</T>
                </View>
              ))}
            </View>
          ) : null}

          <Card pad={14}>
            <T weight="800" size={14}>{t('posapp.sec.parties')}</T>
            <Pair label={t('posapp.applicant')}>{a.applicant.display_name}</Pair>
            <Pair label={t('posapp.organiser')}>{a.organiser.display_name}</Pair>
            <Pair label={t('posapp.position')}>{a.position.title}</Pair>
            {a.position.requirements ? <Pair label={t('posapp.requirements')}>{a.position.requirements}</Pair> : null}
          </Card>

          <Card pad={14}>
            <T weight="800" size={14}>{t('posapp.sec.statement')}</T>
            <T size={14} color={a.message ? c.ink : c.mute} style={{ marginTop: 6, lineHeight: 21 }}>{a.message ?? t('posapp.no_statement')}</T>
          </Card>

          {a.sections.map((sec) => (
            <Card key={sec.key} pad={14}>
              <T weight="800" size={14}>{t(`posapp.sec.${sec.key}`)}</T>
              {sec.rows.map((r) => <Pair key={r.key} label={t(`posapp.f.${r.key}`)}>{answer(r)}</Pair>)}
            </Card>
          ))}

          <Card pad={14}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <T weight="800" size={14} style={{ flex: 1 }}>{t('posapp.sec.documents', { n: a.documents.length })}</T>
              {a.can.add_documents && onDocs ? <Btn small title={t('posapp.manage_docs')} color={c.violet} onPress={onDocs} style={{ minHeight: 44 }} /> : null}
            </View>
            {a.documents.length ? a.documents.map((d) => <Pair key={d.id} label={`${d.content_type === 'application/pdf' ? '📄' : '🖼️'} ${d.title}`}>{kb(d.size_bytes)} · {day(d.created_at)} · {d.uploaded_by_name}</Pair>)
              : <T size={13} color={c.mute} style={{ marginTop: 6 }}>{t('posapp.no_docs')}</T>}
          </Card>

          <Card pad={14}>
            <T weight="800" size={14}>{t('posapp.sec.timeline')}</T>
            {a.timeline.map((h, i) => <Pair key={`${h.at}${i}`} label={day(h.at)}>{[(STATUS[h.to] ?? [h.label])[0], h.actor, h.reason].filter(Boolean).join(' · ')}</Pair>)}
          </Card>
        </>
      )}
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
  const [docs, setDocs] = useState(null), [contract, setContract] = useState(null), [view, setView] = useState(null);
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
              <Btn small title={t('posapp.view')} onPress={() => setView(a)} style={{ minHeight: 44 }} accessibilityLabel={t('posapp.view_a11y', { title: a.title || label })} />
              {a.status === 'invited' ? <><Btn small title="Accept" color={c.lime} onPress={() => act(() => api.post(`/staff-assignments/${a.id}/respond`, { accept: true }), 'Accepted')} /><Btn small title="Decline" color={c.paper} ink={c.red} onPress={() => act(() => api.post(`/staff-assignments/${a.id}/respond`, { accept: false }), 'Declined')} /></> : null}
              {a.contract_id ? <Btn small title={a.status === 'contract_sent' ? 'Review & sign contract' : 'View contract'} color={a.status === 'contract_sent' ? c.lime : c.paper} ink={a.status === 'contract_sent' ? '#fff' : c.ink} onPress={() => setContract(a.contract_id)} /> : null}
              {live ? <Btn small title={`Documents${a.documents ? ` (${a.documents})` : ''}`} color={c.violet} onPress={() => setDocs(a)} /> : null}
              {['applied', 'contract_sent', 'accepted'].includes(a.status) ? <Btn small title={a.status === 'accepted' ? 'Withdraw' : 'Withdraw application'} color={c.paper} ink={c.red} onPress={() => act(() => api.post(`/staff-assignments/${a.id}/end`, {}), 'Withdrawn')} /> : null}
            </View>
          </Card>
        );
      }) : <Empty emoji="📨" title="No applications yet" sub="Apply to an open position and track the organiser's answer, documents and contract here." />}
      {docs ? <PositionDocs assignmentId={docs.id} title={`${docs.event_name} · documents`} onClose={() => setDocs(null)} onChanged={list.reload} /> : null}
      {view && !docs ? <ApplicationSheet id={view.id} onClose={() => setView(null)} onDocs={() => setDocs(view)} /> : null}
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
