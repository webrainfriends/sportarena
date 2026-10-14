import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { FormSheet } from '../FormSheet';
import { PaySheet } from '../PaySheet';
import { Btn, Card, Chip, Empty, ErrorBox, Field, Loading, Section, Seg, Sheet, T, Tag } from '../ui';
import { Counter, DateField, DateRangeField } from '../pickers';
import { c, day } from '../theme';
import { moneyIn } from '../vtime';

const CATEGORIES = [['assessment', 'Assessment'], ['follow_up', 'Follow-up'], ['sports_rehab', 'Sports rehab'], ['remote_consultation', 'Remote consultation'], ['home_visit', 'Home visit'], ['consultation', 'Other']];
const TAX = [['unspecified', 'Not set'], ['taxable', 'Taxable'], ['exempt', 'Exempt'], ['zero_rated', 'Zero-rated'], ['out_of_scope', 'Out of scope']];
const REGIONS = ['neck', 'shoulder', 'elbow', 'wrist_hand', 'upper_back', 'lower_back', 'hip', 'knee', 'ankle_foot', 'core', 'full_body'];
const GOALS = ['mobility', 'strength', 'stability', 'balance', 'endurance', 'pain_relief', 'return_to_sport'];
const label = (v) => String(v).replace(/_/g, ' ').replace(/^./, (x) => x.toUpperCase());
const opts = (list) => list.map((x) => (Array.isArray(x) ? { value: x[0], label: x[1] } : { value: x, label: label(x) }));
const startOf = (d) => (d ? new Date(`${d}T00:00:00`).toISOString() : null);
const endOf = (d) => (d ? new Date(`${d}T23:59:59`).toISOString() : null);

/** Load + loading/error wrapper so every panel has loading, empty and retry states. */
function Async({ res, empty, children }) {
  if (res.loading && !res.data) return <Loading />;
  if (res.error) return <ErrorBox error={res.error} onRetry={res.reload} />;
  return res.data?.length === 0 && empty ? empty : children(res.data);
}

function useAct(reload) {
  const { toast } = useSession();
  return async (fn, msg) => { try { await fn(); toast(msg); reload?.(); } catch (e) { toast('' + e.message); } };
}

// ------------------------------------------------------------------ Services
function Services({ currency }) {
  const list = useLoad(() => api.get('/me/provider-services'), []);
  const [form, setForm] = useState(null);
  const act = useAct(list.reload);
  const edit = form && form !== 'new' ? form : null;
  return (
    <Section title="Services & prices" color={c.mint}>
      <T size={13} color={c.mute}>What patients can book. Changing a price adds a new version: appointments already booked keep the price they were booked at. Do not put patient or clinical details in descriptions.</T>
      <Btn small title="Add a service" color={c.pink} style={{ alignSelf: 'flex-start' }} onPress={() => setForm('new')} />
      <Async res={list} empty={<Empty emoji="🩺" title="No services yet" sub="Add an assessment, follow-up, home visit… with its own duration and price." />}>
        {(rows) => rows.map((s) => (
          <Card key={s.id} pad={12} color={s.archived_at ? c.line : c.paper}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
              <View style={{ flex: 1 }}><T weight="800">{s.title}</T><T size={12} color={c.mute}>{label(s.category)} · {s.duration_min} min · {s.delivery_modes.map(label).join(' + ')}</T></View>
              <View style={{ alignItems: 'flex-end' }}><T weight="900">{moneyIn(Number(s.price_cents), s.currency)}</T><Tag label={label(s.tax_class)} color={c.violetSoft} /></View>
            </View>
            {s.price_history.length > 1 ? <T size={11} color={c.mute} style={{ marginTop: 4 }}>{s.price_history.length} price versions · current since {day(s.effective_from)}</T> : null}
            {s.archived_at ? <Tag label="Archived" color={c.orangeSoft} /> : (
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                <Btn small title="Edit" color={c.violet} onPress={() => setForm(s)} />
                <Btn small title="Archive" color={c.paper} ink={c.red} onPress={() => act(() => api.post(`/me/provider-services/${s.id}/archive`, {}), 'Archived — bookings already made are kept')} />
              </View>
            )}
          </Card>
        ))}
      </Async>
      <FormSheet visible={!!form} onClose={() => setForm(null)} title={edit ? 'Edit service' : 'New service'} submitLabel={edit ? 'Save' : 'Publish'}
        initial={edit ? { title: edit.title, category: edit.category, delivery_modes: edit.delivery_modes, duration_min: edit.duration_min, price_cents: edit.price_cents, tax_class: edit.tax_class, description: edit.description ?? '', cancellation_policy: edit.cancellation_policy ?? '' } : { category: 'assessment', delivery_modes: ['in_person'], duration_min: 30, tax_class: 'unspecified' }}
        fields={[{ key: 'title', label: 'Service name' }, { key: 'category', label: 'Type', type: 'chips', options: opts(CATEGORIES) },
          { key: 'delivery_modes', label: 'Delivered', type: 'multi', options: [{ value: 'in_person', label: 'In person' }, { value: 'remote', label: 'Remote' }] },
          { key: 'duration_min', label: 'Length', type: 'stepper', min: 10, max: 240, step: 5, suffix: ' min' },
          { key: 'price_cents', label: 'Price (tax-inclusive)', type: 'money', currency: currency },
          { key: 'tax_class', label: 'Tax treatment', type: 'chips', options: opts(TAX), hint: 'Set from your own tax advice; the app does not decide it.' },
          { key: 'description', label: 'Public description', type: 'multiline', optional: true }, { key: 'cancellation_policy', label: 'Cancellation / no-show policy', type: 'multiline', optional: true }]}
        onSubmit={async (v) => { await api.post('/me/provider-services', { ...v, ...(edit ? { id: edit.id } : {}), currency: edit?.currency ?? currency }); list.reload(); return edit ? 'Service saved' : 'Service published'; }} />
    </Section>
  );
}

// ------------------------------------------------------------------ Offers
function Offers({ currency }) {
  const list = useLoad(() => api.get('/me/provider-offers'), []);
  const svcs = useLoad(() => api.get('/me/provider-services'), []);
  const [form, setForm] = useState(null);
  const act = useAct(list.reload);
  const mine = (svcs.data ?? []).filter((s) => !s.archived_at).map((s) => ({ value: s.id, label: s.title }));
  const edit = form && form !== 'new' ? form : null;
  return (
    <Section title="Offers" color={c.sun}>
      <T size={13} color={c.mute}>Time-limited discounts. Offers never stack: a patient gets the best single one. Use a code to share an offer privately.</T>
      <Btn small title="Create an offer" color={c.pink} style={{ alignSelf: 'flex-start' }} onPress={() => setForm('new')} />
      <Async res={list} empty={<Empty emoji="🏷️" title="No offers" sub="Create a percentage or fixed discount with dates and limits." />}>
        {(rows) => rows.map((o) => (
          <Card key={o.id} pad={12} color={o.archived_at ? c.line : c.sunSoft}>
            <T weight="800">{o.title}{o.code ? ` · code ${o.code}` : ' · automatic'}</T>
            <T size={12} color={c.mute}>{o.kind === 'percent' ? `${o.percent_bp / 100}% off` : `${moneyIn(Number(o.amount_cents), o.currency)} off`} · {o.service_ids.length ? `${o.service_ids.length} service(s)` : 'all services'} · used {o.used}{o.max_redemptions ? ` of ${o.max_redemptions}` : ''}</T>
            <T size={12} color={c.mute}>{o.valid_from ? day(o.valid_from) : 'now'} → {o.valid_to ? day(o.valid_to) : 'open-ended'}</T>
            {o.archived_at ? <Tag label="Stopped" color={c.orangeSoft} /> : <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}><Btn small title="Edit" color={c.violet} onPress={() => setForm(o)} /><Btn small title="Stop" color={c.paper} ink={c.red} onPress={() => act(() => api.post(`/me/provider-offers/${o.id}/archive`, {}), 'Offer stopped — booked discounts stay')} /></View>}
          </Card>
        ))}
      </Async>
      <FormSheet visible={!!form} onClose={() => setForm(null)} title={edit ? 'Edit offer' : 'New offer'} submitLabel={edit ? 'Save' : 'Create'}
        initial={edit ? { title: edit.title, code: edit.code ?? '', kind: edit.kind, percent: edit.percent_bp ? edit.percent_bp / 100 : 10, amount_cents: edit.amount_cents, service_ids: edit.service_ids, valid_from: edit.valid_from?.slice(0, 10), valid_to: edit.valid_to?.slice(0, 10), max_redemptions: edit.max_redemptions ?? 0, per_user_limit: edit.per_user_limit ?? 0 } : { kind: 'percent', percent: 10, service_ids: [], max_redemptions: 0, per_user_limit: 1 }}
        fields={[{ key: 'title', label: 'Offer name' }, { key: 'kind', label: 'Discount', type: 'choice', options: [{ value: 'percent', label: 'Percentage' }, { value: 'fixed', label: 'Fixed amount' }] },
          { key: 'percent', label: 'Percentage off', type: 'stepper', min: 1, max: 100, suffix: '%', show: (v) => v.kind === 'percent' },
          { key: 'amount_cents', label: 'Amount off', type: 'money', currency, show: (v) => v.kind === 'fixed' },
          { key: 'service_ids', label: 'Applies to (none chosen = all services)', type: 'multi', optional: true, options: mine },
          { key: 'valid_from', label: 'Runs from → to', type: 'daterange', toKey: 'valid_to', optional: true },
          { key: 'code', label: 'Code patients enter (leave empty for automatic)', optional: true, hint: 'Letters and numbers, at least 3.' },
          { key: 'max_redemptions', label: 'Total uses (0 = unlimited)', type: 'stepper', min: 0, max: 10000, step: 1 }, { key: 'per_user_limit', label: 'Uses per patient (0 = unlimited)', type: 'stepper', min: 0, max: 100, step: 1 }]}
        onSubmit={async (v) => {
          await api.post('/me/provider-offers', { ...(edit ? { id: edit.id } : {}), title: v.title, code: v.code || null, kind: v.kind, ...(v.kind === 'percent' ? { percent: v.percent } : { amount_cents: v.amount_cents, currency }), service_ids: v.service_ids ?? [], valid_from: startOf(v.valid_from), valid_to: endOf(v.valid_to), max_redemptions: v.max_redemptions || null, per_user_limit: v.per_user_limit || null });
          list.reload(); return edit ? 'Offer saved' : 'Offer created';
        }} />
    </Section>
  );
}

// ------------------------------------------------------------------ Packages
function Packages({ currency }) {
  const list = useLoad(() => api.get('/me/provider-packages'), []);
  const svcs = useLoad(() => api.get('/me/provider-services'), []);
  const [form, setForm] = useState(null);
  const act = useAct(list.reload);
  const mine = (svcs.data ?? []).filter((s) => !s.archived_at).map((s) => ({ value: s.id, label: s.title }));
  const edit = form && form !== 'new' ? form : null;
  return (
    <Section title="Session packages" color={c.cyan}>
      <T size={13} color={c.mute}>Prepaid bundles of one service. Patients pay once and spend a session at each booking. Nothing is ever charged automatically.</T>
      <Btn small title="Create a package" color={c.pink} disabled={!mine.length} style={{ alignSelf: 'flex-start' }} onPress={() => setForm('new')} />
      {!mine.length ? <T size={12} color={c.mute}>Add a service first.</T> : null}
      <Async res={list} empty={<Empty emoji="🎟️" title="No packages" sub="Bundle 5 or 10 sessions of a service at a package price." />}>
        {(rows) => rows.map((p) => (
          <Card key={p.id} pad={12} color={p.archived_at ? c.line : c.cyanSoft}>
            <T weight="800">{p.title}</T>
            <T size={12} color={c.mute}>{p.sessions} sessions · {moneyIn(Number(p.price_cents), p.currency)} · {p.valid_days ? `valid ${p.valid_days} days after payment` : 'no expiry'} · sold {p.sold}</T>
            {p.refund_terms ? <T size={12} color={c.mute}>Refunds: {p.refund_terms}</T> : null}
            {p.archived_at ? <Tag label="Not on sale" color={c.orangeSoft} /> : <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}><Btn small title="Edit" color={c.violet} onPress={() => setForm(p)} /><Btn small title="Stop selling" color={c.paper} ink={c.red} onPress={() => act(() => api.post(`/me/provider-packages/${p.id}/archive`, {}), 'No longer on sale — bought packages stay valid')} /></View>}
          </Card>
        ))}
      </Async>
      <FormSheet visible={!!form} onClose={() => setForm(null)} title={edit ? 'Edit package' : 'New package'} submitLabel={edit ? 'Save' : 'Create'}
        initial={edit ? { service_id: edit.service_id, title: edit.title, sessions: edit.sessions, price_cents: edit.price_cents, tax_class: edit.tax_class, valid_days: edit.valid_days ?? 0, refund_terms: edit.refund_terms ?? '' } : { sessions: 5, valid_days: 90, tax_class: 'unspecified' }}
        fields={[{ key: 'service_id', label: 'Service', type: 'chips', options: mine }, { key: 'title', label: 'Package name' }, { key: 'sessions', label: 'Sessions', type: 'stepper', min: 2, max: 100 },
          { key: 'price_cents', label: 'Package price (tax-inclusive)', type: 'money', currency }, { key: 'tax_class', label: 'Tax treatment', type: 'chips', options: opts(TAX) },
          { key: 'valid_days', label: 'Valid for (0 = no expiry)', type: 'stepper', min: 0, max: 1825, step: 15, suffix: ' days' }, { key: 'refund_terms', label: 'Refund terms shown before purchase', type: 'multiline', optional: true }]}
        onSubmit={async (v) => { await api.post('/me/provider-packages', { ...(edit ? { id: edit.id } : {}), service_id: v.service_id, title: v.title, sessions: v.sessions, price_cents: v.price_cents, tax_class: v.tax_class, valid_days: v.valid_days || null, refund_terms: v.refund_terms || null }); list.reload(); return edit ? 'Package saved' : 'Package created'; }} />
    </Section>
  );
}

// ------------------------------------------------------------------ Exercise library
function Library() {
  const [region, setRegion] = useState(null), [q, setQ] = useState('');
  const list = useLoad(() => api.get('/me/exercises', { ...(region ? { body_region: region } : {}), ...(q.trim() ? { q: q.trim() } : {}), limit: 100 }), [region, q]);
  const [form, setForm] = useState(null);
  const act = useAct(list.reload);
  const edit = form && form !== 'new' ? form : null;
  return (
    <Section title="Exercise library" color={c.lime}>
      <T size={13} color={c.mute}>Your own exercises. Saving an edit makes a new version; plans already published keep the version they used. Teaching content only: no patient information. {list.data ? `${list.data.total} in your library.` : ''}</T>
      <Field value={q} onChangeText={setQ} placeholder="Search exercises…" />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}><Chip label="All" active={!region} onPress={() => setRegion(null)} />{REGIONS.map((r) => <Chip key={r} label={label(r)} active={region === r} onPress={() => setRegion(r)} />)}</View>
      <Btn small title="Add an exercise" color={c.pink} style={{ alignSelf: 'flex-start' }} onPress={() => setForm('new')} />
      {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : list.data.items.length ? list.data.items.map((e) => (
        <Card key={e.id} pad={12}>
          <T weight="800">{e.title} <T size={11} color={c.mute}>v{e.version}</T></T>
          <T size={12} color={c.mute}>{label(e.body_region)} · {label(e.goal)} · {label(e.difficulty)}{e.equipment.length ? ` · ${e.equipment.join(', ')}` : ''}</T>
          <T size={13} style={{ marginTop: 4 }}>{e.instructions}</T>
          {e.precautions ? <T size={12} color={c.red}>Precautions: {e.precautions}</T> : null}
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}><Btn small title="Edit" color={c.violet} onPress={() => setForm(e)} /><Btn small title="Archive" color={c.paper} ink={c.red} onPress={() => act(() => api.post(`/me/exercises/${e.id}/archive`, {}), 'Archived')} /></View>
        </Card>
      )) : <Empty emoji="🏃" title={q || region ? 'No matches' : 'Your library is empty'} sub={q || region ? 'Try another filter.' : 'Add the exercises you prescribe most.'} />}
      <FormSheet visible={!!form} onClose={() => setForm(null)} title={edit ? 'New version of exercise' : 'New exercise'}
        initial={edit ? { title: edit.title, body_region: edit.body_region, goal: edit.goal, difficulty: edit.difficulty, equipment: edit.equipment.join(', '), instructions: edit.instructions, precautions: edit.precautions ?? '', media_url: edit.media_url ?? '', media_source: edit.media_source ?? '', media_licence: edit.media_licence ?? '' } : { body_region: 'knee', goal: 'mobility', difficulty: 'beginner' }}
        fields={[{ key: 'title', label: 'Name' }, { key: 'body_region', label: 'Body region', type: 'chips', options: opts(REGIONS) }, { key: 'goal', label: 'Goal', type: 'chips', options: opts(GOALS) },
          { key: 'difficulty', label: 'Difficulty', type: 'choice', options: opts(['beginner', 'intermediate', 'advanced']) }, { key: 'equipment', label: 'Equipment (comma separated, e.g. band, roller)', optional: true },
          { key: 'instructions', label: 'How to do it', type: 'multiline' }, { key: 'precautions', label: 'Precautions', type: 'multiline', optional: true },
          { key: 'media_url', label: 'Video or image link (https://…)', optional: true }, { key: 'media_source', label: 'Who made it', optional: true, show: (v) => !!v.media_url }, { key: 'media_licence', label: 'Licence (or "original")', optional: true, show: (v) => !!v.media_url }]}
        onSubmit={async (v) => { await api.post('/me/exercises', { ...(edit ? { id: edit.id } : {}), title: v.title, body_region: v.body_region, goal: v.goal, difficulty: v.difficulty, equipment: (v.equipment ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean), instructions: v.instructions, precautions: v.precautions || null, media_url: v.media_url || null, media_source: v.media_source || null, media_licence: v.media_licence || null }); list.reload(); return 'Exercise saved'; }} />
    </Section>
  );
}

// ------------------------------------------------------------------ Treatment plans (provider)
const toDraft = (plan) => {
  const v = plan.versions.find((x) => x.status === 'draft');
  return v && { base_version: v.version, goals: v.goals ?? '', patient_instructions: v.patient_instructions ?? '', private_notes: v.private_notes ?? '', review_date: v.review_date?.slice(0, 10) ?? null, items: v.items.map((i) => ({ exercise_id: i.exercise_id, title: i.title, sets: i.sets ?? 3, reps: i.reps ?? 10, times_per_week: i.times_per_week ?? 3, hold_sec: i.hold_sec ?? 0, notes: i.notes ?? '' })) };
};

function PlanBuilder({ plan, onClose, onDone }) {
  const { toast } = useSession();
  const patients = useLoad(() => api.get('/medical/patients', { limit: 100 }), []);
  const lib = useLoad(() => api.get('/me/exercises', { limit: 100 }), []);
  const init = plan ? toDraft(plan) : null;
  const [patientId, setPatient] = useState(plan?.patient_id ?? null);
  const [title, setTitle] = useState(plan?.title ?? '');
  const [goals, setGoals] = useState(init?.goals ?? ''), [instr, setInstr] = useState(init?.patient_instructions ?? ''), [priv, setPriv] = useState(init?.private_notes ?? '');
  const [review, setReview] = useState(init?.review_date ?? null);
  const [items, setItems] = useState(init?.items ?? []);
  const [busy, setBusy] = useState(false);
  const full = (patients.data ?? []).filter((p) => p.scope === 'full');
  const patch = (k, p) => setItems((l) => l.map((x, i) => (i === k ? { ...x, ...p } : x)));
  const move = (k, d) => setItems((l) => { const n = [...l]; [n[k], n[k + d]] = [n[k + d], n[k]]; return n; });
  const save = async () => {
    setBusy(true);
    try {
      const body = { goals: goals || undefined, patient_instructions: instr || undefined, private_notes: priv || undefined, review_date: review || undefined, items: items.map(({ title: _t, hold_sec, notes, ...i }) => ({ ...i, ...(hold_sec ? { hold_sec } : {}), ...(notes ? { notes } : {}) })) };
      if (plan) await api.patch(`/treatment-plans/${plan.id}/draft`, { base_version: init.base_version, ...body });
      else await api.post('/treatment-plans', { patient_id: patientId, title, ...body });
      toast('Draft saved — publish it when you are happy'); onDone(); onClose();
    } catch (e) { toast('' + e.message); } finally { setBusy(false); }
  };
  return (
    <Sheet visible onClose={onClose} title={plan ? 'Edit draft' : 'New treatment plan'}>
      {!plan ? <>
        <T weight="800" size={13}>Patient (only people who gave you full access)</T>
        {patients.loading && !patients.data ? <Loading /> : full.length ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{full.map((p) => <Chip key={p.athlete_id} label={p.display_name} active={patientId === p.athlete_id} onPress={() => setPatient(p.athlete_id)} />)}</View> : <T size={12} color={c.mute}>No patient has shared full records with you yet. Ask them to share records from their appointment.</T>}
        <Field label="Plan name" value={title} onChangeText={setTitle} />
      </> : null}
      <Field label="Goals (the patient sees this)" value={goals} onChangeText={setGoals} multiline />
      <Field label="Instructions for the patient" value={instr} onChangeText={setInstr} multiline />
      <Field label="Private notes (only you)" value={priv} onChangeText={setPriv} multiline hint="Never shown to the patient." />
      <DateField label="Review date" value={review} onChange={setReview} optional />
      <T weight="800" size={13}>Exercises, in order</T>
      {items.length ? items.map((it, k) => (
        <Card key={k} pad={10}>
          <T weight="800">{k + 1}. {it.title}</T>
          <Counter label="Sets" value={it.sets} min={1} max={20} onChange={(v) => patch(k, { sets: v })} />
          <Counter label="Reps" value={it.reps} min={1} max={200} onChange={(v) => patch(k, { reps: v })} />
          <Counter label="Hold (seconds, 0 = none)" value={it.hold_sec} min={0} max={600} step={5} onChange={(v) => patch(k, { hold_sec: v })} />
          <Counter label="Days per week" value={it.times_per_week} min={1} max={7} onChange={(v) => patch(k, { times_per_week: v })} />
          <Field label="Note for the patient" value={it.notes} onChangeText={(v) => patch(k, { notes: v })} />
          <View style={{ flexDirection: 'row', gap: 6 }}>
            <Btn small title="↑ Up" color={c.paper} ink={c.ink} disabled={k === 0} accessibilityLabel="Move up" onPress={() => move(k, -1)} />
            <Btn small title="↓ Down" color={c.paper} ink={c.ink} disabled={k === items.length - 1} accessibilityLabel="Move down" onPress={() => move(k, 1)} />
            <Btn small title="Remove" color={c.paper} ink={c.red} onPress={() => setItems((l) => l.filter((_, i) => i !== k))} />
          </View>
        </Card>
      )) : <T size={12} color={c.mute}>Add at least one exercise from your library.</T>}
      <T weight="800" size={13}>Add from your library</T>
      {lib.data?.items.length ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{lib.data.items.map((e) => <Chip key={e.id} label={`+ ${e.title}`} onPress={() => setItems((l) => [...l, { exercise_id: e.id, title: e.title, sets: 3, reps: 10, times_per_week: 3, hold_sec: 0, notes: '' }])} />)}</View> : <T size={12} color={c.mute}>Your exercise library is empty — add exercises first.</T>}
      <Btn title="Save draft" color={c.pink} loading={busy} disabled={(!plan && (!patientId || title.trim().length < 2)) || !items.length} onPress={save} />
    </Sheet>
  );
}

function PlanSheet({ id, onClose, onChanged }) {
  const res = useLoad(() => api.get(`/treatment-plans/${id}`), [id]);
  const [edit, setEdit] = useState(false);
  const act = useAct(() => { res.reload(); onChanged(); });
  const p = res.data;
  const draft = p?.versions.find((v) => v.status === 'draft'), pub = p?.versions.find((v) => v.status === 'published');
  return (
    <Sheet visible onClose={onClose} title={p?.title ?? 'Treatment plan'}>
      {res.loading && !p ? <Loading /> : res.error ? <ErrorBox error={res.error} onRetry={res.reload} /> : <>
        <T size={13} color={c.mute}>{p.patient_name} · <T weight="800" size={13}>{p.status}</T></T>
        {p.versions.map((v) => (
          <Card key={v.id} pad={12} color={v.status === 'draft' ? c.sunSoft : v.status === 'published' ? c.mintSoft : c.paper}>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><T weight="900">Version {v.version}</T><Tag label={v.status} color={v.status === 'published' ? c.lime : v.status === 'draft' ? c.sun : c.violetSoft} />{v.status === 'published' ? <Tag label={v.acknowledged_at ? 'patient acknowledged' : 'awaiting acknowledgement'} color={v.acknowledged_at ? c.lime : c.orangeSoft} /> : null}</View>
            {v.goals ? <T size={13}>Goals: {v.goals}</T> : null}
            {v.private_notes ? <T size={12} color={c.mute}>Private: {v.private_notes}</T> : null}
            {v.items.map((i) => <T key={i.id} size={13}>• {i.title}: {[i.sets && `${i.sets}×`, i.reps, i.hold_sec ? `hold ${i.hold_sec}s` : null, i.times_per_week ? `${i.times_per_week}/wk` : null].filter(Boolean).join(' ')}</T>)}
          </Card>
        ))}
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          {draft ? <><Btn small title="Edit draft" color={c.violet} onPress={() => setEdit(true)} /><Btn small title="Publish to patient" color={c.pink} onPress={() => act(() => api.post(`/treatment-plans/${id}/publish`, { base_version: draft.version, material_change: true }), 'Published — the patient is notified')} /></> : null}
          {!draft && pub ? <Btn small title="Revise (new draft)" color={c.violet} onPress={() => act(() => api.post(`/treatment-plans/${id}/revise`, {}), 'New draft started')} /> : null}
          {['active', 'paused'].includes(p.status) ? <>
            <Btn small title={p.status === 'active' ? 'Pause' : 'Resume'} color={c.paper} ink={c.ink} onPress={() => act(() => api.post(`/treatment-plans/${id}/status`, { status: p.status === 'active' ? 'paused' : 'active' }), 'Updated')} />
            <Btn small title="Complete" color={c.paper} ink={c.ink} onPress={() => act(() => api.post(`/treatment-plans/${id}/status`, { status: 'completed' }), 'Plan completed')} />
            <Btn small title="Discharge" color={c.paper} ink={c.red} onPress={() => act(() => api.post(`/treatment-plans/${id}/status`, { status: 'discharged' }), 'Patient discharged')} /></> : null}
        </View>
        {edit ? <PlanBuilder plan={p} onClose={() => setEdit(false)} onDone={() => { res.reload(); onChanged(); }} /> : null}
      </>}
    </Sheet>
  );
}

function Plans() {
  const list = useLoad(() => api.get('/treatment-plans', { limit: 50 }), []);
  const [open, setOpen] = useState(null), [build, setBuild] = useState(false);
  const mine = (list.data ?? []).filter((p) => p.as === 'provider');
  return (
    <Section title="Patient treatment plans" color={c.violet}>
      <T size={13} color={c.mute}>Exercise programmes for patients who gave you full access. Published versions can never be changed: revise to make a new one. Access ends the moment a patient withdraws it.</T>
      <Btn small title="New treatment plan" color={c.pink} style={{ alignSelf: 'flex-start' }} onPress={() => setBuild(true)} />
      {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : mine.length ? mine.map((p) => (
        <Card key={p.id} pad={12} onPress={() => setOpen(p.id)}><View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><View><T weight="800">{p.title}</T><T size={12} color={c.mute}>{p.patient_name} · updated {day(p.updated_at)}</T></View><Tag label={p.status} color={p.status === 'active' ? c.lime : c.sun} /></View></Card>
      )) : <Empty emoji="📝" title="No treatment plans" sub="Create one for a patient who has shared their records with you." />}
      {open ? <PlanSheet id={open} onClose={() => setOpen(null)} onChanged={list.reload} /> : null}
      {build ? <PlanBuilder onClose={() => setBuild(false)} onDone={list.reload} /> : null}
    </Section>
  );
}

// ------------------------------------------------------------------ Tax & revenue
function TaxRevenue({ currency }) {
  const tax = useLoad(() => api.get('/me/tax-profile'), []);
  const [form, setForm] = useState(null);
  const today = new Date(), iso = (d) => d.toISOString().slice(0, 10);
  const [range, setRange] = useState({ from: iso(new Date(today.getFullYear(), today.getMonth(), 1)), to: iso(today) }), [basis, setBasis] = useState('billed');
  const rep = useLoad(() => api.get('/me/practice-report', { ...range, basis }), [range.from, range.to, basis]);
  const cur = tax.data?.current;
  return (
    <>
      <Section title="Tax settings" color={c.orange}>
        <T size={13} color={c.mute}>You tell the app your registration and rate; it never decides tax for you and holds no built-in rates. Each change is dated and earlier periods keep what applied then.</T>
        {tax.loading && !tax.data ? <Loading /> : tax.error ? <ErrorBox error={tax.error} onRetry={tax.reload} /> : (
          <Card pad={12}>
            {cur ? <><T weight="800">{cur.legal_name}</T><T size={12} color={c.mute}>{cur.jurisdiction} · {cur.registration_status === 'registered' ? `registered${cur.registration_id ? ` (${cur.registration_id})` : ''}` : 'not tax registered'}</T></> : <T size={13}>No tax profile yet — taxable services are reported without tax.</T>}
            <T size={12} color={c.mute}>Rates: {tax.data.rates.length ? tax.data.rates.map((r) => `${r.rate_bp / 100}% from ${day(r.effective_from)}`).join(' · ') : 'none recorded'}</T>
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 8, flexWrap: 'wrap' }}><Btn small title={cur ? 'Update profile' : 'Set profile'} color={c.violet} onPress={() => setForm('profile')} /><Btn small title="Record a rate" color={c.pink} onPress={() => setForm('rate')} /></View>
          </Card>
        )}
      </Section>
      <FormSheet visible={form === 'profile'} onClose={() => setForm(null)} title="Practice tax profile" initial={{ legal_name: cur?.legal_name ?? '', jurisdiction: cur?.jurisdiction ?? '', registration_status: cur?.registration_status ?? 'not_registered', registration_id: cur?.registration_id ?? '' }}
        fields={[{ key: 'legal_name', label: 'Legal billing name' }, { key: 'jurisdiction', label: 'Country / state of registration' }, { key: 'registration_status', label: 'Tax registration', type: 'choice', options: [{ value: 'registered', label: 'Registered' }, { value: 'not_registered', label: 'Not registered' }] }, { key: 'registration_id', label: 'Registration number', optional: true, show: (v) => v.registration_status === 'registered' }]}
        onSubmit={async (v) => { await api.post('/me/tax-profile', { legal_name: v.legal_name, jurisdiction: v.jurisdiction, registration_status: v.registration_status, ...(v.registration_status === 'registered' ? { registration_id: v.registration_id } : {}) }); tax.reload(); rep.reload(); return 'Tax profile saved'; }} />
      <FormSheet visible={form === 'rate'} onClose={() => setForm(null)} title="Tax rate for taxable services" initial={{ rate_percent: 0 }}
        fields={[{ key: 'rate_percent', label: 'Rate', type: 'stepper', min: 0, max: 100, step: 0.5, suffix: '%' }, { key: 'source', label: 'Where this rate comes from', type: 'multiline', hint: 'e.g. the official notice or your accountant\'s advice. Required.' }]}
        onSubmit={async (v) => { await api.post('/me/tax-rates', { rate_percent: v.rate_percent, source: v.source }); tax.reload(); rep.reload(); return 'Rate recorded'; }} />
      <Section title="Revenue report" color={c.mint}>
        <DateRangeField label="Period" from={range.from} to={range.to} onChange={(r) => r.from && setRange({ from: r.from, to: r.to ?? r.from })} />
        <Seg options={[{ value: 'billed', label: 'Billed' }, { value: 'collected', label: 'Collected' }]} value={basis} onChange={setBasis} color={c.mint} />
        <T size={12} color={c.mute}>{basis === 'billed' ? 'Confirmed and completed appointments by date of visit.' : 'Payments received by payment date, net of refunds.'} Prices include tax.</T>
        {rep.loading && !rep.data ? <Loading /> : rep.error ? <ErrorBox error={rep.error} onRetry={rep.reload} /> : rep.data.groups.length ? rep.data.groups.map((g) => (
          <Card key={`${g.currency}${g.tax_class}`} pad={12}>
            <T weight="800">{g.currency} · {label(g.tax_class)} <T size={12} color={c.mute}>({g.lines} visit{g.lines === 1 ? '' : 's'})</T></T>
            <T size={13}>Net revenue {moneyIn(g.net_cents, g.currency)} + tax {moneyIn(g.tax_cents, g.currency)} = <T weight="900" size={13}>{moneyIn(g.gross_cents, g.currency)}</T></T>
            {g.discount_cents ? <T size={12} color={c.mute}>Discounts given {moneyIn(g.discount_cents, g.currency)}</T> : null}
            {g.refunded_cents ? <T size={12} color={c.mute}>Refunded {moneyIn(g.refunded_cents, g.currency)}</T> : null}
            {g.untaxed_taxable_lines ? <T size={12} color={c.red}>{g.untaxed_taxable_lines} taxable visit(s) had no tax registration or rate in force, so no tax is shown.</T> : null}
          </Card>
        )) : <Empty emoji="🧾" title="Nothing in this period" />}
        {rep.data ? <T size={11} color={c.mute}>{rep.data.note} Time zone {rep.data.period.timezone}.</T> : null}
      </Section>
    </>
  );
}

// ------------------------------------------------------------------ Provider workspace
export function PracticePanel() {
  const [tab, setTab] = useState('services');
  const pm = useLoad(() => api.get('/payments/methods'), []);
  const currency = pm.data?.currency ?? 'INR';
  return (
    <View style={{ gap: 10 }}>
      <Seg options={[{ value: 'services', label: 'Services', emoji: '🩺' }, { value: 'offers', label: 'Offers', emoji: '🏷️' }, { value: 'packages', label: 'Packages', emoji: '🎟️' }, { value: 'plans', label: 'Plans', emoji: '📝' }, { value: 'library', label: 'Exercises', emoji: '🏃' }, { value: 'money', label: 'Tax & revenue', emoji: '🧾' }]} value={tab} onChange={setTab} color={c.violet} />
      {tab === 'services' && <Services currency={currency} />}
      {tab === 'offers' && <Offers currency={currency} />}
      {tab === 'packages' && <Packages currency={currency} />}
      {tab === 'plans' && <Plans />}
      {tab === 'library' && <Library />}
      {tab === 'money' && <TaxRevenue currency={currency} />}
    </View>
  );
}

// ------------------------------------------------------------------ Patient: my plans & packages
function PlanView({ id, onClose, onChanged }) {
  const res = useLoad(() => api.get(`/treatment-plans/${id}`), [id]);
  const act = useAct(() => { res.reload(); onChanged(); });
  const p = res.data, v = p?.versions.find((x) => x.status === 'published');
  return (
    <Sheet visible onClose={onClose} title={p?.title ?? 'Exercise plan'}>
      {res.loading && !p ? <Loading /> : res.error ? <ErrorBox error={res.error} onRetry={res.reload} /> : !v ? <Empty emoji="📝" title="This plan has been replaced or is not active" /> : <>
        <T size={13} color={c.mute}>From {p.provider_name} · version {v.version} · {p.status}</T>
        {v.goals ? <Card pad={12} color={c.mintSoft}><T weight="800">Your goals</T><T size={13}>{v.goals}</T></Card> : null}
        {v.patient_instructions ? <T size={13}>{v.patient_instructions}</T> : null}
        {v.items.map((i) => (
          <Card key={i.id} pad={12}>
            <T weight="800">{i.title}</T>
            <T size={13} color={c.mute}>{[i.sets && i.reps ? `${i.sets} sets × ${i.reps}` : null, i.hold_sec ? `hold ${i.hold_sec}s` : null, i.side ? `${i.side} side` : null, i.times_per_week ? `${i.times_per_week} days a week` : null].filter(Boolean).join(' · ')}</T>
            <T size={13} style={{ marginTop: 4 }}>{i.instructions}</T>
            {i.notes ? <T size={13}>Note: {i.notes}</T> : null}
            {i.precautions ? <T size={12} color={c.red}>Take care: {i.precautions}</T> : null}
            {i.stop_instructions ? <T size={12} color={c.red}>Stop if: {i.stop_instructions}</T> : null}
          </Card>
        ))}
        {v.review_date ? <T size={12} color={c.mute}>Next review: {day(v.review_date)}</T> : null}
        <T size={11} color={c.mute}>This plan is not an emergency service and messages are not monitored continuously. If you feel worse or unsafe, contact your clinician or emergency services.</T>
        {v.acknowledged_at ? <Tag label="You confirmed you have read this" color={c.lime} /> : <Btn title="I have read this plan" color={c.mint} ink={c.ink} onPress={() => act(() => api.post(`/treatment-plans/${id}/acknowledge`, {}), 'Thanks — your clinician can see you read it')} />}
      </>}
    </Sheet>
  );
}

export function MyRehab() {
  const { toast } = useSession();
  const plans = useLoad(() => api.get('/treatment-plans', { limit: 50 }), []);
  const pk = useLoad(() => api.get('/me/packages'), []);
  const [open, setOpen] = useState(null), [paying, setPaying] = useState(null);
  const mine = (plans.data ?? []).filter((p) => p.as === 'patient');
  return (
    <View style={{ gap: 10 }}>
      <Section title="My exercise plans" color={c.lime}>
        {plans.loading && !plans.data ? <Loading /> : plans.error ? <ErrorBox error={plans.error} onRetry={plans.reload} /> : mine.length ? mine.map((p) => <Card key={p.id} pad={12} onPress={() => setOpen(p.id)}><View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><View><T weight="800">{p.title}</T><T size={12} color={c.mute}>From {p.provider_name} · updated {day(p.updated_at)}</T></View><Tag label={p.status} color={p.status === 'active' ? c.lime : c.sun} /></View></Card>) : <Empty emoji="📝" title="No exercise plans yet" sub="When your physio publishes a plan it appears here. You decide who can see your records under Access." />}
      </Section>
      <Section title="My session packages" color={c.cyan}>
        {pk.loading && !pk.data ? <Loading /> : pk.error ? <ErrorBox error={pk.error} onRetry={pk.reload} /> : pk.data.length ? pk.data.map((k) => (
          <Card key={k.id} pad={12}>
            <T weight="800">{k.title}</T>
            <T size={12} color={c.mute}>{k.status === 'awaiting_payment' ? 'Awaiting payment' : k.status === 'cancelled' ? 'Cancelled' : `${k.sessions_left} of ${k.sessions_total} sessions left${k.expires_at ? ` · expires ${day(k.expires_at)}` : ''}`}</T>
            {k.refund_terms ? <T size={11} color={c.mute}>Refund terms: {k.refund_terms}</T> : null}
            {k.status === 'awaiting_payment' ? <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
              <Btn small title={`Pay ${moneyIn(Number(k.price_cents), k.currency)}`} color={c.pink} onPress={() => setPaying({ type: 'physio_package', id: k.id, amount: Number(k.price_cents), currency: k.currency, label: k.title })} />
              <Btn small title="Cancel" color={c.paper} ink={c.red} onPress={async () => { try { await api.post(`/me/packages/${k.id}/cancel`, {}); toast('Cancelled'); pk.reload(); } catch (e) { toast('' + e.message); } }} /></View> : null}
          </Card>
        )) : <Empty emoji="🎟️" title="No packages" sub="Buy a package when you book a service that offers one." />}
      </Section>
      {open ? <PlanView id={open} onClose={() => setOpen(null)} onChanged={plans.reload} /> : null}
      {paying ? <PaySheet target={paying} onClose={() => setPaying(null)} onDone={pk.reload} /> : null}
    </View>
  );
}
