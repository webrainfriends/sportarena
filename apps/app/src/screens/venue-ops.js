// The venue team's operations tabs: what needs attention, maintenance, lockers with PINs, vendors and contracts.
// (Courts, photos, rates, offers, plans, documents and insurance stay in their own tabs.)
import React, { useState } from 'react';
import { Platform, Share, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, ErrorBox, Loading, Row, Section, StatPill, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c } from '../theme';
import { addDays, dateTimeIn, moneyIn, timeIn, todayIn } from '../vtime';
import { pickDocument } from './insurance';

const day = (d) => (d ? String(d).slice(0, 10) : '');
const ATTENTION_TAB = { maintenance_overdue: 'maintenance', maintenance_urgent: 'maintenance', contracts_ending: 'vendors', insurance_expiring: 'docs', no_insurance: 'docs' };

/** The things that need a decision, as tappable cards under the venue title. Hidden when there is nothing. */
export function OpsAttention({ venueId, go }) {
  const o = useLoad(() => api.get(`/venues/${venueId}/operations`), [venueId]);
  if (!o.data?.attention?.length) return null;
  return (
    <View style={{ marginTop: 10, gap: 6 }}>
      {o.data.attention.map((a) => <Card key={a.key} color={c.sunSoft} pad={10} onPress={() => go(ATTENTION_TAB[a.key])}><T weight="700" size={13}>⚠ {a.text}</T></Card>)}
    </View>
  );
}

const share = async (message, toast) => {
  try {
    if (Platform.OS === 'web' && navigator.clipboard) { await navigator.clipboard.writeText(message); toast('Copied — paste it into a message'); }
    else await Share.share({ message });
  } catch { toast('Could not share'); }
};

// ------------------------------------------------------------------ maintenance
const CATEGORY = [['general', 'General'], ['surface', 'Surface'], ['lighting', 'Lighting'], ['equipment', 'Equipment'], ['plumbing', 'Plumbing'], ['electrical', 'Electrical'], ['cleaning', 'Cleaning'], ['safety', 'Safety'], ['inspection', 'Inspection'], ['other', 'Other']];
const PRIORITY = { urgent: ['🔴', 'Urgent'], high: ['🟠', 'High'], normal: ['🔵', 'Normal'], low: ['⚪', 'Low'] };
const REPEAT = [{ value: 0, label: 'No repeat' }, { value: 30, label: 'Monthly' }, { value: 90, label: 'Quarterly' }, { value: 180, label: '6 months' }, { value: 365, label: 'Yearly' }];

export function Maintenance({ v }) {
  const { toast } = useSession();
  const [filter, setFilter] = useState('open');
  const [form, setForm] = useState(false);
  const [finish, setFinish] = useState(null);
  const list = useLoad(() => api.get(`/venues/${v.id}/maintenance`, { status: filter, limit: 100 }), [v.id, filter]);
  const vendors = useLoad(() => api.get(`/venues/${v.id}/vendors`), [v.id]);
  const t = list.data?.totals;
  const set = async (m, status) => { try { await api.patch(`/maintenance/${m.id}`, { status }); list.reload(); } catch (e) { toast(e.message); } };
  const maintVendors = (vendors.data ?? []).filter((x) => x.status === 'active' && x.kind === 'maintenance');
  const today = todayIn(v.timezone);
  return (
    <Section title="Maintenance" color={c.orange}>
      <T color={c.mute} size={13}>Log work on a court or the whole venue, assign a vendor, track cost, repeat it on a schedule — and close the court so nobody can book it meanwhile.</T>
      {t ? <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}><StatPill label="Open" value={String(t.open)} /><StatPill label="Overdue" value={String(t.overdue)} /><StatPill label="Spent this year" value={moneyIn(Number(t.cost_this_year_cents), v.currency)} /></View> : null}
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
        {[['open', 'Open'], ['done', 'Done'], ['cancelled', 'Cancelled'], ['all', 'All']].map(([k, l]) => <Chip key={k} label={l} active={filter === k} onPress={() => setFilter(k)} />)}
      </View>
      <Btn small title="＋ Log maintenance" color={c.violet} onPress={() => setForm(true)} style={{ alignSelf: 'flex-start' }} />
      {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : list.data.items.length ? list.data.items.map((m) => (
        <Card key={m.id} pad={12} color={m.overdue ? c.sunSoft : c.paper}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <T style={{ flex: 1 }} weight="800">{PRIORITY[m.priority][0]} {m.title}</T>
            <Tag label={m.status.replace('_', ' ')} />
          </View>
          <T size={12} color={c.mute}>{[m.court ?? 'Whole venue', CATEGORY.find(([k]) => k === m.category)?.[1], m.due_on && `due ${day(m.due_on)}${m.overdue ? ' · overdue' : ''}`, m.vendor_name, m.repeat_every_days && `repeats every ${m.repeat_every_days} days`, m.block_batch_id && 'court closed'].filter(Boolean).join(' · ')}</T>
          {m.estimated_cost_cents != null || m.actual_cost_cents != null ? <T size={12} color={c.mute}>{m.actual_cost_cents != null ? `Cost ${moneyIn(Number(m.actual_cost_cents), v.currency)}` : `Estimate ${moneyIn(Number(m.estimated_cost_cents), v.currency)}`}</T> : null}
          {m.notes ? <T size={12}>{m.notes}</T> : null}
          {['scheduled', 'in_progress'].includes(m.status) ? (
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              {m.status === 'scheduled' ? <Btn small title="Start" color={c.violet} onPress={() => set(m, 'in_progress')} /> : null}
              <Btn small title="Mark done" onPress={() => setFinish(m)} />
              <Btn small title="Cancel" color={c.paper} ink={c.red} onPress={() => set(m, 'cancelled')} />
            </View>
          ) : null}
        </Card>
      )) : <Empty emoji="🛠️" title="Nothing here" sub="Log maintenance as it comes up, or set a repeat for regular upkeep." />}
      <FormSheet visible={form} onClose={() => setForm(false)} title="Log maintenance" submitLabel="Save"
        fields={[{ key: 'title', label: 'What needs doing', placeholder: 'e.g. Resurface Court 2' },
          { key: 'category', label: 'Kind of work', type: 'chips', default: 'general', options: CATEGORY.map(([value, label]) => ({ value, label })) },
          { key: 'priority', label: 'How urgent', type: 'chips', default: 'normal', options: Object.entries(PRIORITY).map(([value, [e, label]]) => ({ value, label: `${e} ${label}` })) },
          { key: 'resource_id', label: 'Where', type: 'chips', blank: true, options: [{ value: '', label: 'Whole venue' }, ...v.resources.map((r) => ({ value: r.id, label: `${r.sport_emoji ?? ''} ${r.name}`.trim() }))] },
          { key: 'due_on', label: 'Due on', type: 'date', optional: true },
          { key: 'vendor_id', label: 'Vendor', type: 'chips', blank: true, optional: true, options: [{ value: '', label: 'Not assigned' }, ...maintVendors.map((x) => ({ value: x.id, label: x.name }))], hint: maintVendors.length ? undefined : 'Add maintenance contractors under Vendors & contracts' },
          { key: 'estimated_cost_cents', label: 'Estimated cost', type: 'money', currency: v.currency, optional: true },
          { key: 'repeat_every_days', label: 'Repeat', type: 'chips', default: 0, options: REPEAT },
          { key: 's1', type: 'section', label: 'Close the court meanwhile' },
          { key: 'close', label: 'Block bookings during the work', type: 'switch', default: false },
          { key: 'close_from', toKey: 'close_to', label: 'Closed from – to', type: 'daterange', show: (x) => x.close },
          { key: 'cancel_conflicting', label: 'Cancel & refund bookings in the way', type: 'switch', default: false, show: (x) => x.close },
          { key: 'notes', label: 'Notes', type: 'multiline', optional: true }]}
        initial={{ due_on: addDays(today, 7) }}
        onSubmit={async ({ s1, close, close_from, close_to, cancel_conflicting, resource_id, vendor_id, repeat_every_days, ...f }) => {
          await api.post(`/venues/${v.id}/maintenance`, { ...f, resource_id: resource_id || undefined, vendor_id: vendor_id || undefined, repeat_every_days: repeat_every_days || undefined,
            ...(close ? { close: { from_date: close_from, to_date: close_to ?? close_from, cancel_conflicting: !!cancel_conflicting } } : {}) });
          list.reload(); return 'Logged';
        }} />
      <FormSheet visible={!!finish} onClose={() => setFinish(null)} title={`Done: ${finish?.title ?? ''}`} submitLabel="Mark done"
        fields={[{ key: 'actual_cost_cents', label: 'What it cost', type: 'money', currency: v.currency, optional: true }, { key: 'notes', label: 'Notes', type: 'multiline', optional: true }]}
        initial={{ actual_cost_cents: finish?.estimated_cost_cents ?? undefined, notes: finish?.notes ?? '' }}
        onSubmit={async (f) => { const r = await api.patch(`/maintenance/${finish.id}`, { ...f, status: 'done' }); list.reload(); return r.next_job ? `Done — next one due ${day(r.next_job.due_on)}` : 'Done'; }} />
    </Section>
  );
}

// ------------------------------------------------------------------ lockers
export function Lockers({ v, reload }) {
  const { toast } = useSession();
  const [add, setAdd] = useState(false);
  const [retired, setRetired] = useState(false);
  const [give, setGive] = useState(null);
  const lockers = useLoad(() => api.get(`/venues/${v.id}/lockers`, { include_retired: retired }), [v.id, retired]);
  const desk = useLoad(() => api.get(`/venues/${v.id}/locker-assignments`, { limit: 100 }), [v.id]);
  const upcoming = useLoad(async () => {
    const rows = await api.get(`/venues/${v.id}/schedule`, { from: new Date().toISOString(), to: new Date(Date.now() + 7 * 864e5).toISOString() });
    const seen = new Set();
    return rows.filter((b) => b.reservation_id && b.status === 'confirmed' && !seen.has(b.reservation_id) && seen.add(b.reservation_id));
  }, [v.id]);
  const all = () => { lockers.reload(); desk.reload(); upcoming.reload(); };
  const held = new Set((desk.data ?? []).map((a) => a.reservation_id));
  const need = (upcoming.data ?? []).filter((b) => !held.has(b.reservation_id));
  const run = async (fn, ok) => { try { const r = await fn(); all(); if (ok) toast(ok(r)); } catch (e) { toast(e.message); } };
  const active = (lockers.data ?? []).filter((l) => l.active);
  return (
    <>
      <Section title="Lockers" color={c.cyan}>
        <T color={c.mute} size={13}>Add your lockers once. Each booking can get a free locker with its own PIN for the booking time; the PIN shows in the booking details for the person who booked.</T>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          <StatPill label="Lockers" value={String(active.length)} /><StatPill label="In use now" value={String(active.filter((l) => l.in_use_now).length)} />
        </View>
        <Card pad={12}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View style={{ flex: 1 }}><T weight="700">Give every booking a locker automatically</T><T size={12} color={c.mute}>When one is free, new bookings get a locker and PIN straight away.</T></View>
            <Btn small title={v.locker_auto_assign ? 'On' : 'Off'} color={v.locker_auto_assign ? c.lime : c.paper} ink={v.locker_auto_assign ? '#fff' : c.ink}
              onPress={() => run(async () => { await api.patch(`/venues/${v.id}`, { locker_auto_assign: !v.locker_auto_assign }); reload(); }, () => 'Saved')} />
          </View>
        </Card>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          <Btn small title="＋ Add lockers" color={c.violet} onPress={() => setAdd(true)} />
          <Btn small title={retired ? 'Hide retired' : 'Show retired'} color={c.paper} ink={c.violet} onPress={() => setRetired(!retired)} />
        </View>
        {lockers.loading && !lockers.data ? <Loading /> : lockers.data?.length ? lockers.data.map((l) => (
          <Row key={l.id} title={`🔐 ${l.label}${l.active ? '' : ' · retired'}`} sub={[l.zone, l.size, l.in_use_now ? `in use by ${l.in_use_by_code} until ${timeIn(l.in_use_until, v.timezone)}` : l.active ? 'free now' : null, l.upcoming && `${l.upcoming} booking${l.upcoming === 1 ? '' : 's'} ahead`].filter(Boolean).join(' · ')}
            right={<Btn small title={l.active ? 'Retire' : 'Restore'} color={c.paper} ink={l.active ? c.red : c.violet} onPress={() => run(() => api.patch(`/lockers/${l.id}`, { active: !l.active }))} />} />
        )) : <Empty emoji="🔐" title="No lockers yet" sub="Add them by name or a numbered range, with the zone they are in." />}
      </Section>
      <Section title="Front desk" color={c.violet}>
        <T color={c.mute} size={13}>Who holds which locker, with the PIN. Share it again or issue a new PIN if it leaked.</T>
        {desk.data?.length ? desk.data.map((a) => (
          <Card key={a.id} pad={12}>
            <T weight="800">{a.label}{a.zone ? ` · ${a.zone}` : ''} · PIN {a.pin}</T>
            <T size={12} color={c.mute}>{a.holder} · booking {a.code} · {dateTimeIn(a.starts_at, v.timezone)} → {timeIn(a.ends_at, v.timezone)}{a.shared_at ? ' · shared' : ''}</T>
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              <Btn small title="Share" color={c.violet} onPress={() => run(async () => share((await api.post(`/locker-assignments/${a.id}/share`, {})).message, toast))} />
              <Btn small title="New PIN" color={c.paper} ink={c.violet} onPress={() => run(() => api.post(`/locker-assignments/${a.id}/pin`, {}), (r) => `New PIN ${r.pin}`)} />
              <Btn small title="Release" color={c.paper} ink={c.red} onPress={() => run(() => api.del(`/locker-assignments/${a.id}`))} />
            </View>
          </Card>
        )) : <Empty emoji="🧳" title="No lockers handed out" sub="Bookings that get a locker show up here." />}
      </Section>
      <Section title="Bookings this week without a locker" color={c.pink}>
        {need.length ? need.slice(0, 30).map((b) => (
          <Row key={b.reservation_id} title={`${b.reservation_code} · ${b.customer ?? 'Guest'}`} sub={`${b.resource_name} · ${dateTimeIn(b.starts_at, v.timezone)}`}
            right={<Btn small title="Give locker" color={c.violet} onPress={() => setGive(b)} />} />
        )) : <T size={13} color={c.mute}>{upcoming.loading ? 'Checking…' : 'Every booking in the next 7 days has a locker, or none are booked.'}</T>}
      </Section>
      <FormSheet visible={add} onClose={() => setAdd(false)} title="Add lockers" submitLabel="Add"
        fields={[{ key: 'prefix', label: 'Name (numbers are added)', placeholder: 'A  →  A1, A2, A3…' }, { key: 'count', label: 'How many', type: 'stepper', min: 1, max: 100, default: 10 },
          { key: 'zone', label: 'Where', optional: true, placeholder: "e.g. Men's changing room" },
          { key: 'size', label: 'Size', type: 'chips', default: 'medium', options: [{ value: 'small', label: 'Small' }, { value: 'medium', label: 'Medium' }, { value: 'large', label: 'Large' }] }]}
        onSubmit={async (f) => { const r = await api.post(`/venues/${v.id}/lockers`, { ...f, start_number: (lockers.data ?? []).filter((l) => l.label.startsWith(f.prefix)).length + 1 }); all(); return `${r.created.length} added${r.skipped ? `, ${r.skipped} already existed` : ''}`; }} />
      <FormSheet visible={!!give} onClose={() => setGive(null)} title={`Locker for ${give?.reservation_code ?? ''}`} submitLabel="Assign & make PIN"
        fields={[{ key: 'size', label: 'Size', type: 'chips', blank: true, optional: true, options: [{ value: '', label: 'Any' }, { value: 'small', label: 'Small' }, { value: 'medium', label: 'Medium' }, { value: 'large', label: 'Large' }] },
          { key: 'digits', label: 'PIN length', type: 'chips', default: 4, options: [4, 5, 6].map((n) => ({ value: n, label: `${n} digits` })) }]}
        onSubmit={async (f) => { const r = await api.post(`/reservations/${give.reservation_id}/locker`, { size: f.size || undefined, digits: f.digits }); all(); return `Locker ${r.label} · PIN ${r.pin}`; }} />
    </>
  );
}

// ------------------------------------------------------------------ vendors & contracts
const VENDOR_KIND = { maintenance: '🛠️ Maintenance', supplier: '📦 Supplier', cleaning: '🧹 Cleaning', security: '🛡️ Security', technology: '💻 Technology', other: 'Other' };
const SKILLS = ['Surface', 'Lighting', 'Plumbing', 'Electrical', 'Nets & posts', 'Cleaning', 'Drinks & food', 'Sports kit', 'First aid', 'Scoreboards & AV', 'Uniforms', 'Pest control'];
const TERMS = ['Advance', 'On delivery', 'Net 15', 'Net 30', 'Net 45'];
const CONTRACT_KIND = { maintenance: 'Maintenance', supply: 'Supply', service: 'Service', lease: 'Lease', sponsorship: 'Sponsorship', other: 'Other' };

export function VendorsContracts({ v }) {
  const { toast } = useSession();
  const [vendorForm, setVendorForm] = useState(null); // {} = new, row = edit
  const [contractForm, setContractForm] = useState(null);
  const [archived, setArchived] = useState(false);
  const vendors = useLoad(() => api.get(`/venues/${v.id}/vendors`, { include_archived: archived }), [v.id, archived]);
  const contracts = useLoad(() => api.get(`/venues/${v.id}/contracts`), [v.id]);
  const all = () => { vendors.reload(); contracts.reload(); };
  const live = (vendors.data ?? []).filter((x) => x.status !== 'archived');
  const attach = async (k) => {
    try {
      const f = await pickDocument();
      if (!f) return;
      const d = await api.upload('/documents', f.blob, { subject_type: 'venue', subject_id: v.id, kind: 'contract', title: `${k.title} (signed)`.slice(0, 120) });
      await api.patch(`/contracts/${k.id}`, { document_id: d.id });
      contracts.reload(); toast('Signed copy attached');
    } catch (e) { toast(e.message); }
  };
  const open = async (k) => {
    try {
      if (Platform.OS === 'web') { const url = URL.createObjectURL(await api.download(`/documents/${k.document_id}/file`)); window.open(url, '_blank', 'noopener'); setTimeout(() => URL.revokeObjectURL(url), 12000); }
      else toast('Open contract files in the web app');
    } catch (e) { toast(e.message); }
  };
  const vf = vendorForm ?? {};
  return (
    <>
      <Section title="Vendors" color={c.lime}>
        <T color={c.mute} size={13}>Maintenance contractors and suppliers of consumables and kit. Names, phones and emails are encrypted; your team sees them here.</T>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          <Btn small title="＋ Add vendor" color={c.violet} onPress={() => setVendorForm({})} />
          <Btn small title={archived ? 'Hide archived' : 'Show archived'} color={c.paper} ink={c.violet} onPress={() => setArchived(!archived)} />
        </View>
        {vendors.loading && !vendors.data ? <Loading /> : vendors.error ? <ErrorBox error={vendors.error} onRetry={vendors.reload} /> : vendors.data.length ? vendors.data.map((x) => (
          <Card key={x.id} pad={12} onPress={() => setVendorForm(x)}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><T weight="800" style={{ flex: 1 }}>{x.name}</T>{x.emergency_24x7 ? <Tag label="24×7" color={c.sunSoft} /> : null}{x.status !== 'active' ? <Tag label={x.status} /> : null}</View>
            <T size={12} color={c.mute}>{[VENDOR_KIND[x.kind], x.categories.join(', '), x.rating && `${'★'.repeat(x.rating)}`].filter(Boolean).join(' · ')}</T>
            <T size={12} color={c.mute}>{[x.contact_name, x.phone, x.email].filter(Boolean).join(' · ') || 'No contact details'}</T>
            <T size={12} color={c.mute}>{[x.lead_time_days != null && `lead time ${x.lead_time_days} d`, x.payment_terms, x.open_jobs && `${x.open_jobs} open job${x.open_jobs === 1 ? '' : 's'}`, x.live_contracts && `${x.live_contracts} contract${x.live_contracts === 1 ? '' : 's'}`].filter(Boolean).join(' · ')}</T>
          </Card>
        )) : <Empty emoji="📇" title="No vendors yet" sub="Add the people you call when something breaks and the companies you buy from." />}
      </Section>
      <Section title="Contracts" color={c.sun}>
        <T color={c.mute} size={13}>Keep each agreement with its term, value and signed copy. You are reminded before it ends. Insurance policies live under Documents & insurance.</T>
        <Btn small title="＋ Add contract" color={c.violet} onPress={() => setContractForm({})} style={{ alignSelf: 'flex-start' }} />
        {contracts.loading && !contracts.data ? <Loading /> : contracts.data?.length ? contracts.data.map((k) => (
          <Card key={k.id} pad={12} color={k.ending_soon ? c.sunSoft : c.paper}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><T weight="800" style={{ flex: 1 }}>{k.title}</T><Tag label={k.status} /></View>
            <T size={12} color={c.mute}>{[CONTRACT_KIND[k.kind], k.vendor_name, k.reference, k.starts_on && `${day(k.starts_on)} → ${day(k.ends_on) || 'open-ended'}`, k.ends_on && k.status === 'active' && (k.days_left < 0 ? 'lapsed' : `${k.days_left} days left`), k.auto_renews && 'renews itself', k.value_cents != null && moneyIn(Number(k.value_cents), v.currency), k.payment_terms].filter(Boolean).join(' · ')}</T>
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              {k.document_id ? <Btn small title="Open signed copy" color={c.violet} onPress={() => open(k)} /> : <Btn small title="Attach signed copy" color={c.violet} onPress={() => attach(k)} />}
              <Btn small title="Edit" color={c.paper} ink={c.violet} onPress={() => setContractForm(k)} />
              {k.status === 'active' ? <Btn small title="Mark ended" color={c.paper} ink={c.red} onPress={async () => { try { await api.patch(`/contracts/${k.id}`, { status: 'ended' }); contracts.reload(); } catch (e) { toast(e.message); } }} /> : null}
            </View>
          </Card>
        )) : <Empty emoji="📑" title="No contracts yet" sub="Annual maintenance, supply agreements, the lease — add them so renewals never surprise you." />}
      </Section>
      <FormSheet visible={!!vendorForm} onClose={() => setVendorForm(null)} title={vf.id ? `Edit ${vf.name}` : 'Add a vendor'} submitLabel="Save"
        initial={{ kind: 'maintenance', ...vf, categories: vf.categories ?? [], lead_time_days: vf.lead_time_days ?? 0, rating: vf.rating ?? 0, status: vf.status ?? 'active' }}
        fields={[{ key: 'kind', label: 'Type', type: 'chips', options: Object.entries(VENDOR_KIND).map(([value, label]) => ({ value, label })) },
          { key: 'name', label: 'Company or person' },
          { key: 'categories', label: 'What they do or supply', type: 'multi', optional: true, options: [...new Set([...SKILLS, ...(vf.categories ?? [])])] },
          { key: 's1', type: 'section', label: 'Contact' },
          { key: 'contact_name', label: 'Contact person', optional: true }, { key: 'phone', label: 'Phone', input: 'phone', optional: true }, { key: 'email', label: 'Email', input: 'email', optional: true },
          { key: 'address', label: 'Address', optional: true }, { key: 'website', label: 'Website', input: 'url', optional: true },
          { key: 'emergency_24x7', label: 'Takes emergency calls 24×7', type: 'switch', default: false },
          { key: 's2', type: 'section', label: 'Terms' },
          { key: 'lead_time_days', label: 'Usual lead time', type: 'stepper', min: 0, max: 90, step: 1, suffix: ' days' },
          { key: 'payment_terms', label: 'Payment terms', type: 'chips', blank: true, optional: true, options: TERMS },
          { key: 'rating', label: 'Your rating', type: 'chips', optional: true, options: [{ value: 0, label: 'Not rated' }, ...[1, 2, 3, 4, 5].map((n) => ({ value: n, label: '★'.repeat(n) }))] },
          { key: 'notes', label: 'Notes', type: 'multiline', optional: true },
          ...(vf.id ? [{ key: 'status', label: 'Status', type: 'chips', options: [{ value: 'active', label: 'Active' }, { value: 'paused', label: 'Paused' }, { value: 'archived', label: 'Archived' }] }] : [])]}
        onSubmit={async ({ s1, s2, rating, ...f }) => {
          const body = { ...f, rating: rating || undefined };
          if (vf.id) await api.patch(`/vendors/${vf.id}`, body); else await api.post(`/venues/${v.id}/vendors`, body);
          all(); return 'Saved';
        }} />
      <FormSheet visible={!!contractForm} onClose={() => setContractForm(null)} title={contractForm?.id ? 'Edit contract' : 'Add a contract'} submitLabel="Save"
        initial={{ kind: 'maintenance', notice_days: 30, ...contractForm, starts_on: day(contractForm?.starts_on) || undefined, ends_on: day(contractForm?.ends_on) || undefined, vendor_id: contractForm?.vendor_id ?? '', value_cents: contractForm?.value_cents != null ? Number(contractForm.value_cents) : undefined }}
        fields={[{ key: 'kind', label: 'Type', type: 'chips', options: Object.entries(CONTRACT_KIND).map(([value, label]) => ({ value, label })) },
          { key: 'title', label: 'Title', placeholder: 'e.g. Floodlight annual maintenance' },
          { key: 'vendor_id', label: 'With', type: 'chips', blank: true, optional: true, options: [{ value: '', label: 'Not linked to a vendor' }, ...live.map((x) => ({ value: x.id, label: x.name }))] },
          { key: 'starts_on', toKey: 'ends_on', label: 'Term', type: 'daterange', optional: true },
          { key: 'auto_renews', label: 'Renews itself unless cancelled', type: 'switch', default: false },
          { key: 'notice_days', label: 'Remind me before it ends', type: 'stepper', min: 0, max: 180, step: 15, suffix: ' days' },
          { key: 'value_cents', label: 'Contract value', type: 'money', currency: v.currency, optional: true },
          { key: 'payment_terms', label: 'Payment terms', type: 'chips', blank: true, optional: true, options: TERMS },
          { key: 'reference', label: 'Reference no.', optional: true }, { key: 'notes', label: 'Notes', type: 'multiline', optional: true }]}
        onSubmit={async ({ vendor_id, ...f }) => {
          const body = { ...f, vendor_id: vendor_id || (contractForm?.id ? null : undefined) };
          if (contractForm?.id) await api.patch(`/contracts/${contractForm.id}`, body); else await api.post(`/venues/${v.id}/contracts`, body);
          all(); return 'Saved';
        }} />
    </>
  );
}
