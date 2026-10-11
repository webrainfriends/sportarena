// Departments of an event (operations, medical, media, volunteers, officials …): create them, invite people, answer invitations,
// see the roster and manage accreditation. Contact details are only shown to the organiser and department leads, and each view is logged.
import React, { useState } from 'react';
import { Switch, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { A, AAvatar, ABtn, ACard, AChip, AEmpty, AHero, AScreen, ASection, AT, AG, DeptChip } from '../arena';
import { EntityPicker } from '../entity-picker';
import { ErrorBox, Field, Loading, Sheet, T } from '../ui';
import { Counter } from '../pickers';

const COLOURS = ['#7C3AED', '#EC4899', '#06B6D4', '#10B981', '#F59E0B', '#EF4444', '#3B82F6', '#A3E635'];
const ACCRED = { none: ['No badge', A.mute], requested: ['Badge requested', A.sun], issued: ['Badge issued', A.green], revoked: ['Badge revoked', A.red] };
const KIND_ICON = { operations: '🧭', medical: '🩺', media: '🎥', hospitality: '🍽️', security: '🛡️', volunteers: '🙋', officials: '🟨', logistics: '📦', tech: '📡', ceremonies: '🎖️', custom: '✨' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Date of birth: year stepper, month chips, day stepper — a month-by-month calendar is too slow for a date decades ago. */
function DobField({ value, onChange }) {
  const now = new Date().getFullYear();
  const [y, m, d] = (value ?? `${now - 20}-01-01`).split('-').map(Number);
  const days = new Date(y, m, 0).getDate();
  const put = (yy, mm, dd) => onChange(`${yy}-${String(mm).padStart(2, '0')}-${String(Math.min(dd, new Date(yy, mm, 0).getDate())).padStart(2, '0')}`);
  return (
    <View style={{ gap: 8 }}>
      <T weight="600" size={12} color="#64748B">DATE OF BIRTH{value ? '' : ' (not set: change any control to add it)'}</T>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}><T weight="700">Year</T><Counter value={y} onChange={(x) => put(x, m, d)} min={now - 100} max={now - 5} /></View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{MONTHS.map((n, i) => <AChip key={n} label={n} active={m === i + 1} onPress={() => put(y, i + 1, d)} />)}</View>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}><T weight="700">Day</T><Counter value={Math.min(d, days)} onChange={(x) => put(y, m, x)} min={1} max={days} /></View>
    </View>
  );
}

export function EventDepartments({ id }) {
  const { user } = useSession();
  const ev = useLoad(() => api.get(`/events/${id}`), [id]);
  if (ev.error) return <AScreen><ErrorBox error={ev.error} onRetry={ev.reload} /></AScreen>;
  if (!ev.data) return <AScreen><Loading /></AScreen>;
  return (
    <AScreen>
      <AHero kicker="Departments" title={ev.data.name} sub="Teams behind the event, and who is in them" tone={AG.neon} emoji="🧩" />
      <DepartmentsTab id={id} isOrg={!!user && (ev.data.organizer_id === user.id || user.roles?.includes('admin'))} />
    </AScreen>
  );
}

export function DepartmentsTab({ id, isOrg }) {
  const { user, toast } = useSession();
  const depts = useLoad(() => api.get(`/events/${id}/departments`), [id]);
  const mine = useLoad(() => api.get('/me/department-invites', { status: 'invited' }), [id]);
  const [sel, setSel] = useState(null);
  const [form, setForm] = useState(false);
  const [accept, setAccept] = useState(null);
  const reload = () => { depts.reload(); mine.reload(); };
  if (depts.error) return <ErrorBox error={depts.error} onRetry={depts.reload} />;
  if (!depts.data) return <Loading />;
  const list = depts.data;
  const cur = list.find((d) => d.id === sel) ?? list[0] ?? null;
  const invites = (mine.data ?? []).filter((x) => x.event_id === id);
  const answer = async (inv, yes, extra = {}) => {
    try { await api.post(`/department-members/${inv.id}/respond`, { accept: yes, ...extra }); toast(yes ? `Welcome to ${inv.department}!` : 'Declined'); reload(); } catch (x) { toast('' + x.message); }
  };
  return (
    <>
      {invites.map((inv) => (
        <ACard key={inv.id} tone={inv.colour}>
          <AT size={12} weight="800" color={A.mute}>YOU ARE INVITED</AT>
          <AT size={18} weight="900" style={{ marginTop: 2 }}>{KIND_ICON[inv.kind] ?? '✨'} {inv.department}{inv.role === 'lead' ? ' (lead)' : ''}</AT>
          {inv.title ? <AT size={13} color={A.mute}>{inv.title}</AT> : null}
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
            <ABtn small title="Join" tone="lime" onPress={() => setAccept(inv)} /><ABtn small title="Not now" tone="ghost" onPress={() => answer(inv, false)} />
          </View>
        </ACard>
      ))}

      <ASection title="Departments" action={isOrg ? '+ New' : undefined} onAction={() => setForm(true)} />
      {list.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {list.map((d) => <DeptChip key={d.id} dept={d} active={cur?.id === d.id} count={d.active_members} onPress={() => setSel(d.id)} />)}
        </View>
      ) : <AEmpty emoji="🧩" title="No departments yet" sub={isOrg ? 'Add the teams you need, or let AI suggest them from the overview.' : 'You are not in any department of this event.'} action={isOrg ? 'Create the first one' : undefined} onAction={() => setForm(true)} />}

      {cur ? <DepartmentPanel key={cur.id} dept={cur} isOrg={isOrg} user={user} reload={reload} toast={toast} /> : null}
      <NewDepartment visible={form} onClose={() => setForm(false)} eventId={id} onDone={(d) => { setSel(d.id); reload(); }} />
      <JoinSheet inv={accept} onClose={() => setAccept(null)} onJoin={(extra) => answer(accept, true, extra)} />
    </>
  );
}

function DepartmentPanel({ dept, isOrg, user, reload, toast }) {
  const isLead = dept.lead_user_id === user?.id;
  const manage = isOrg || isLead;
  const [pii, setPii] = useState(false);
  const [add, setAdd] = useState([]);
  const roster = useLoad(() => api.get(`/events/${dept.event_id}/roster`, { department_id: dept.id, include_pii: pii || undefined, limit: 100 }), [dept.id, pii]);
  const act = async (fn, msg) => { try { await fn(); if (msg) toast(msg); roster.reload(); reload(); } catch (x) { toast('' + x.message); } };
  const invite = () => act(async () => { for (const p of add) await api.post(`/departments/${dept.id}/members`, { user_id: p.id }); setAdd([]); }, `Invited ${add.length}`);
  const rows = (roster.data ?? []).filter((r) => r.status === 'active' || r.status === 'invited');
  return (
    <>
      <ACard tone={dept.colour} style={{ gap: 6 }}>
        <AT size={20} weight="900">{KIND_ICON[dept.kind] ?? '✨'} {dept.name}</AT>
        {dept.description ? <AT size={13} color={A.mute}>{dept.description}</AT> : null}
        <AT size={12.5} weight="700" color={A.mute}>{dept.lead_name ? `Lead: ${dept.lead_name}` : 'No lead yet'} · {dept.active_members} active · {dept.invited_members} invited</AT>
        {manage ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 6 }}>
            <Switch value={pii} onValueChange={setPii} trackColor={{ true: A.violet }} />
            <AT size={12.5} weight="700" color={A.mute} style={{ flex: 1 }}>Show contact details (logged)</AT>
          </View>
        ) : null}
      </ACard>

      {manage ? (
        <ACard style={{ gap: 10 }}>
          <EntityPicker kind="person" multi label="Invite people" value={add} onChange={setAdd} />
          {add.length ? <ABtn small title={`Invite ${add.length}`} tone="hero" onPress={invite} /> : null}
        </ACard>
      ) : null}

      <ASection title="Roster" sub={`${rows.length} people`} />
      {roster.error ? <ErrorBox error={roster.error} onRetry={roster.reload} /> : null}
      {!roster.data ? <Loading /> : rows.length ? rows.map((r) => (
        <ACard key={r.member_id} pad={12} style={{ gap: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <AAvatar user={r} size={40} />
            <View style={{ flex: 1 }}>
              <AT size={15} weight="800">{r.display_name}{r.role === 'lead' ? '  ⭐' : ''}</AT>
              <AT size={12} color={A.mute}>@{r.handle}{r.title ? ` · ${r.title}` : ''}{r.status === 'invited' ? ' · invited' : ''}</AT>
            </View>
            <AT size={11} weight="800" color={ACCRED[r.accreditation][1]}>{ACCRED[r.accreditation][0].toUpperCase()}</AT>
          </View>
          {pii && (r.phone || r.dob || r.id_number) ? <AT size={12} color={A.mute}>{[r.phone, r.dob, r.id_number ? `ID ${r.id_number}` : null].filter(Boolean).join(' · ')}</AT> : null}
          {manage && r.status === 'active' ? (
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              {r.accreditation !== 'issued' ? <AChip label={r.accreditation === 'requested' ? 'Issue badge' : 'Request badge'} color={A.green} onPress={() => act(() => api.post(`/department-members/${r.member_id}/accreditation`, { status: r.accreditation === 'requested' ? 'issued' : 'requested' }), 'Updated')} /> : <AChip label="Revoke badge" color={A.red} onPress={() => act(() => api.post(`/department-members/${r.member_id}/accreditation`, { status: 'revoked' }), 'Badge revoked')} />}
              <AChip label="Remove" color={A.red} onPress={() => act(() => api.post(`/department-members/${r.member_id}/leave`), 'Removed')} />
            </View>
          ) : null}
          {manage && r.status === 'invited' ? <AChip label="Withdraw invite" color={A.red} onPress={() => act(() => api.post(`/department-members/${r.member_id}/leave`), 'Withdrawn')} /> : null}
        </ACard>
      )) : <AEmpty emoji="👥" title="Nobody here yet" sub={manage ? 'Invite people above.' : undefined} />}
      {isOrg ? <ABtn small tone="ghost" title="Archive this department" onPress={() => act(() => api.patch(`/departments/${dept.id}`, { archived: true }), 'Archived')} /> : null}
    </>
  );
}

function NewDepartment({ visible, onClose, eventId, onDone }) {
  const { toast } = useSession();
  const kinds = useLoad(() => api.get('/department-kinds'), []);
  const [name, setName] = useState('');
  const [kind, setKind] = useState('operations');
  const [colour, setColour] = useState(COLOURS[0]);
  const [lead, setLead] = useState([]);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const d = await api.post(`/events/${eventId}/departments`, { name: name.trim() || kind[0].toUpperCase() + kind.slice(1), kind, colour, lead_user_id: lead[0]?.id });
      toast('Department created'); setName(''); setLead([]); onClose(); onDone(d);
    } catch (x) { toast('' + x.message); } finally { setBusy(false); }
  };
  return (
    <Sheet visible={visible} onClose={onClose} title="New department">
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{(kinds.data ?? []).map((k) => <AChip key={k.key} label={`${KIND_ICON[k.key] ?? ''} ${k.key}`} active={kind === k.key} onPress={() => setKind(k.key)} />)}</View>
      <T size={12} color="#64748B">{kinds.data?.find((k) => k.key === kind)?.description}</T>
      <Field label="Name" value={name} onChangeText={setName} placeholder="Defaults to the kind" />
      <T weight="600" size={12} color="#64748B">COLOUR</T>
      <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>{COLOURS.map((x) => <AChip key={x} label={colour === x ? '✓' : '  '} active={colour === x} color={x} onPress={() => setColour(x)} style={{ backgroundColor: x, borderColor: x, minWidth: 44 }} />)}</View>
      <EntityPicker kind="person" label="Department lead" optional value={lead} onChange={setLead} />
      <ABtn title="Create department" onPress={save} loading={busy} />
    </Sheet>
  );
}

function JoinSheet({ inv, onClose, onJoin }) {
  const [phone, setPhone] = useState('');
  const [dob, setDob] = useState(null);
  const [idn, setIdn] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => { setBusy(true); try { await onJoin({ phone: phone || undefined, dob: dob || undefined, id_number: idn || undefined }); onClose(); } finally { setBusy(false); } };
  return (
    <Sheet visible={!!inv} onClose={onClose} title={inv ? `Join ${inv.department}` : ''}>
      <T size={13} color="#475569">Optional: your details are stored encrypted and only the organiser and department lead can see them, for accreditation badges.</T>
      <Field label="Phone" value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
      <DobField value={dob} onChange={setDob} />
      <Field label="ID number" value={idn} onChangeText={setIdn} secure />
      <ABtn title="Join the team" tone="lime" onPress={go} loading={busy} />
    </Sheet>
  );
}
