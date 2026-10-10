// Open positions: the public job board for tournaments (crew and vendor places). Anyone can browse; applying needs a login.
// Applicants and organisers exchange documents on the application; the organiser accepts and issues a contract, the applicant signs it.
import React, { useRef, useState } from 'react';
import { Platform, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, ErrorBox, Field, H1, Loading, Row, Screen, Seg, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { pickDocument } from './insurance';
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
      if (Platform.OS === 'web') { const url = URL.createObjectURL(await api.download(`/staff-documents/${d.id}/file`)); window.open(url, '_blank', 'noopener'); setTimeout(() => URL.revokeObjectURL(url), 120000); }
      else toast('Open documents in the web app');
    } catch (e) { toast(e.message); }
  };
  const remove = async (d) => { try { await api.del(`/staff-documents/${d.id}`); await docs.reload(); onChanged?.(); } catch (e) { toast(e.message); } };
  return (
    <Sheet visible onClose={onClose} title={title ?? 'Documents'}>
      <T size={12} color={c.mute}>Share licences, certificates, insurance, menus, briefs — anything the other side needs. PDF or photo, up to 10 MB. Only you and the other party can open them; files are encrypted. Removing one only hides it.</T>
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
function ApplySheet({ p, onClose, onApplied }) {
  const [sent, setSent] = useState(null);
  const done = useRef(false); // the form closes itself after a successful send; keep this sheet to offer the documents step
  if (sent) return <PositionDocs assignmentId={sent} title="Add documents for the organiser" onClose={() => { onClose(); onApplied?.(); }} />;
  const vendor = p.pay_direction === 'applicant_pays';
  return (
    <FormSheet visible onClose={() => { if (!done.current) onClose(); }} title={`Apply: ${p.title || ROLE_META[p.role]?.[1]}`} submitLabel="Send application"
      fields={[
        { key: 'message', label: 'Why you are a fit', type: 'multiline', optional: true, hint: `${p.event_name} · ${dates(p)} · ${feeLine(p)}. Your profile is shared with the organiser.` },
        { key: 'fee', label: vendor ? 'Stall fee you offer' : 'Your fee, if different', type: 'money', currency: p.currency, optional: true },
      ]}
      onSubmit={async (v) => {
        const a = await api.post(`/staff-roles/${p.id}/apply`, { message: v.message || undefined, fee_cents: v.fee || undefined });
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
  const [tab, setTab] = useState('browse');
  const [key, setKey] = useState(0);
  return (
    <Screen wide>
      <H1>Open positions</H1>
      <T color={c.mute} style={{ marginTop: 4 }}>Referees, scorers, doctors, volunteers, security, stalls and caterers wanted by tournaments. Apply, share documents and sign the contract here.</T>
      <View style={{ marginVertical: 10 }}><Seg options={[{ value: 'browse', label: 'Browse' }, { value: 'mine', label: 'My applications' }]} value={tab} onChange={setTab} color={c.pink} /></View>
      {tab === 'browse' ? <OpenPositions key={key} columns={2} onChanged={() => setKey((k) => k + 1)} onOpenMine={() => setTab('mine')} /> : user ? <MyApplications /> : null}
    </Screen>
  );
}
