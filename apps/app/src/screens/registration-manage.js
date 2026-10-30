import React, { useEffect, useState } from 'react';
import { Switch, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Btn, Card, Chip, Empty, Field, H1, Loading, Screen, Section, Seg, T, Tag } from '../ui';
import { MenuField } from '../menu-field';
import { Counter, DateField, DateTimeField } from '../pickers';
import { CurrencyDropdown } from '../currency-dropdown';
import { SportSelect } from '../sportpicker';
import { saveFile } from '../contracts-ui';
import { c } from '../theme';
import { explain, LoadError } from '../access';
import { fieldsOf, fmtMoney, fromMinor, toMinor } from '../application-forms';
import { DefinitionEditor, strip, withDefaults } from './sponsor-form-builder';
import { KINDS, StatusTag, kindOf, places } from './registration';

const day = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const stamp = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const Toggle = ({ label, hint, value, onChange }) => (
  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44 }}>
    <View style={{ flex: 1 }}><T weight="800" size={13}>{label}</T>{hint ? <T size={12} color={c.mute}>{hint}</T> : null}</View>
    <Switch accessibilityLabel={label} value={!!value} onValueChange={onChange} />
  </View>
);
const STATUS_FILTER = [{ value: '', label: 'All registrations' }, { value: 'submitted', label: 'Submitted' }, { value: 'under_review', label: 'Under review' }, { value: 'info_requested', label: 'More information needed' }, { value: 'waitlisted', label: 'Waiting list' }, { value: 'approved', label: 'Confirmed' }, { value: 'rejected', label: 'Declined' }, { value: 'withdrawn', label: 'Withdrawn' }];

/** The organiser's console for one programme: the queue, the decisions, open/close, export and the entry points to its settings and form. */
export function RegistrationManage({ id }) {
  const { toast } = useSession();
  const { push } = useNav();
  const prog = useLoad(() => api.get(`/registration-programmes/${id}`), [id]);
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const list = useLoad(() => api.get(`/registration-programmes/${id}/entries`, { ...(status ? { status } : {}), ...(q.trim() ? { q: q.trim() } : {}), limit: 100 }), [id, status, q]);
  const p = prog.data;
  if (prog.error) return <Screen><LoadError error={prog.error} onRetry={prog.reload} /></Screen>;
  if (prog.loading && !p) return <Screen><Loading /></Screen>;
  if (!p.can_manage) return <Screen><Empty emoji="🔒" title="Only the organisers can manage this" /></Screen>;
  const k = kindOf(p.kind), a = p.availability;
  const reload = () => { prog.reload(); list.reload(); };
  const setProgStatus = async (s) => { try { await api.post(`/registration-programmes/${id}/status`, { status: s }); toast(s === 'open' ? 'Registration is open' : s === 'closed' ? 'Registration closed' : 'Archived'); reload(); } catch (e) { toast(explain(e)); } };
  const exportCsv = async () => { try { const f = await api.get(`/registration-programmes/${id}/export`); const how = await saveFile(f.filename, f.csv); toast(how === 'cancelled' ? 'Cancelled' : `${f.rows} registrations exported. This download is logged.`); } catch (e) { toast(explain(e)); } };
  const counts = p.counts ?? {};
  return (
    <Screen onRefresh={reload} refreshing={prog.loading && !!p} wide>
      <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}><T size={28}>{k.emoji}</T><View style={{ flex: 1 }}><H1>{p.title}</H1><T size={12} color={c.mute} style={{ marginTop: 4 }}>{[k.label, p.organisation_name ?? p.event_name, `version ${p.current_version || '–'}`].filter(Boolean).join(' · ')}</T></View><Tag label={p.status} color={p.status === 'open' ? c.limeSoft : c.violetSoft} /></View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {[['Confirmed', counts.approved], ['To review', (counts.submitted ?? 0) + (counts.under_review ?? 0)], ['Waiting', counts.waitlisted], ['Sent back', counts.info_requested]].map(([l, n]) => (
          <Card key={l} style={{ minWidth: 120, flexGrow: 1 }}><T size={26} weight="900">{n ?? 0}</T><T size={12} color={c.mute}>{l}</T></Card>
        ))}
        <Card style={{ minWidth: 120, flexGrow: 1 }}><T size={26} weight="900">{a.capacity == null ? '∞' : `${a.held}/${a.capacity}`}</T><T size={12} color={c.mute}>Places held</T></Card>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {p.status !== 'open' && p.status !== 'archived' ? <Btn small title={p.status === 'closed' ? 'Reopen' : 'Open registration'} onPress={() => setProgStatus('open')} /> : null}
        {p.status === 'open' ? <Btn small title="Close registration" color={c.paper} ink={c.ink} onPress={() => setProgStatus('closed')} /> : null}
        <Btn small title="Settings" color={c.violet} onPress={() => push('RegistrationSetup', { id })} />
        <Btn small title="Form, fees and waivers" color={c.violet} onPress={() => push('RegistrationForm', { id })} />
        <Btn small title="Export CSV" color={c.paper} ink={c.ink} onPress={exportCsv} />
        {p.status !== 'archived' ? <Btn small title="Archive" color={c.paper} ink={c.red} onPress={() => setProgStatus('archived')} /> : null}
      </View>
      {!p.current_version ? <Card color={c.sunSoft}><T weight="800">Publish the form first</T><T size={13}>People cannot register until the questions, fees and waivers are published.</T></Card> : null}
      <Section title="Registrations" color={c.pink}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <View style={{ flexGrow: 1, minWidth: 220 }}><MenuField value={status} onChange={setStatus} options={STATUS_FILTER} /></View>
          <View style={{ flexGrow: 2, minWidth: 220 }}><Field value={q} onChangeText={setQ} placeholder="Name, team or receipt" maxLength={80} accessibilityLabel="Search registrations" /></View>
        </View>
        {list.error ? <LoadError error={list.error} onRetry={list.reload} /> : list.loading && !list.data ? <Loading /> : list.data?.length ? list.data.map((e) => (
          <Card key={e.id} onPress={() => push('RegistrationEntry', { id: e.id })} accessibilityLabel={`${e.participant_name ?? e.team_name}, ${e.status}`}>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
              <View style={{ flex: 1 }}><T weight="900" numberOfLines={1}>{e.participant_name ?? e.team_name}</T><T size={12} color={c.mute} numberOfLines={1}>{[e.team_name && e.participant_name ? e.team_name : null, e.receipt_no, stamp(e.submitted_at)].filter(Boolean).join(' · ')}</T></View>
              <StatusTag status={e.status} />
            </View>
            {e.total_cents > 0 ? <T size={12} color={e.due_cents > 0 ? c.sun : c.lime}>{e.due_cents > 0 ? `${fmtMoney(e.paid_cents, e.currency)} of ${fmtMoney(e.total_cents, e.currency)} paid` : `${fmtMoney(e.total_cents, e.currency)} paid`}</T> : null}
            {e.eligibility && e.eligibility.decision !== 'eligible' ? <T size={12} color={c.red}>Eligibility: {e.eligibility.decision}</T> : null}
          </Card>
        )) : <Empty emoji="📭" title="No registrations here" sub={status || q ? 'Nothing matches the filter.' : 'Submitted registrations appear here for your decision.'} />}
      </Section>
    </Screen>
  );
}

const iso = (d) => (d ? new Date(d).toISOString() : null);

/** Create or change a programme: what it is, who runs it, when it is open, how many places, and the rules. */
export function RegistrationSetup({ id, kind: kind0, event_id: event0 }) {
  const { toast } = useSession();
  const { replace, back } = useNav();
  const load = useLoad(() => (id ? api.get(`/registration-programmes/${id}`) : Promise.resolve(null)), [id]);
  const orgs = useLoad(() => api.get('/organisations').catch(() => []), []);
  const { user } = useSession();
  const events = useLoad(() => api.get('/events', { organizer_id: user?.id, limit: 50 }).catch(() => []), [user?.id]);
  const [f, setF] = useState({ kind: kind0 ?? 'course', title: '', summary: '', sport: '', organisation_id: '', event_id: event0 ?? '', opens_at: null, closes_at: null, capacity: null, waitlist: true, needs_approval: true, allow_dependents: true, currency: '', quotaField: '', limits: {} });
  const [busy, setBusy] = useState(false);
  const p = load.data;
  useEffect(() => {
    if (!p) return;
    const q = p.quotas?.[0];
    setF({ kind: p.kind, title: p.title, summary: p.summary ?? '', sport: p.sport ?? '', organisation_id: p.organisation_id ?? '', event_id: p.event_id ?? '', opens_at: p.opens_at, closes_at: p.closes_at, capacity: p.capacity, waitlist: p.waitlist, needs_approval: p.needs_approval, allow_dependents: p.allow_dependents, currency: p.currency, quotaField: q?.field ?? '', limits: q?.limits ?? {} });
  }, [p?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  if (load.error) return <Screen><LoadError error={load.error} onRetry={load.reload} /></Screen>;
  if (id && load.loading && !p) return <Screen><Loading /></Screen>;
  const choiceQs = (p?.version ? fieldsOf(p.version.form) : []).filter((x) => x.type === 'choice' && !x.confidential);
  const needsEvent = f.kind === 'competition';
  const ok = f.title.trim().length >= 2 && (!needsEvent || f.event_id) && f.currency;
  const save = async () => {
    setBusy(true);
    try {
      const body = {
        title: f.title.trim(), ...(f.summary.trim() ? { summary: f.summary.trim() } : {}), ...(f.sport ? { sport: f.sport } : {}), capacity: f.capacity, waitlist: f.waitlist, needs_approval: f.needs_approval,
        allow_dependents: f.allow_dependents, currency: f.currency, opens_at: iso(f.opens_at), closes_at: iso(f.closes_at),
        quotas: f.quotaField ? [{ field: f.quotaField, limits: f.limits }] : [],
      };
      if (id) { await api.patch(`/registration-programmes/${id}`, { ...body, row_version: p.row_version }); toast('Saved'); back(); }
      else { const made = await api.post('/registration-programmes', { kind: f.kind, ...(f.organisation_id ? { organisation_id: f.organisation_id } : {}), ...(f.event_id ? { event_id: f.event_id } : {}), ...body, ...(f.capacity == null ? { capacity: undefined } : {}), opens_at: body.opens_at ?? undefined, closes_at: body.closes_at ?? undefined }); toast('Created. Now publish the form.'); replace('RegistrationForm', { id: made.id }); }
    } catch (e) { toast(explain(e)); } finally { setBusy(false); }
  };
  const opt = choiceQs.find((x) => x.key === f.quotaField);
  return (
    <Screen wide>
      <H1>{id ? 'Programme settings' : 'New registration programme'}</H1>
      <T size={13} color={c.mute}>One framework for every kind of registration. Pick what people register for; you design the questions, fees and waivers next.</T>
      <Section title="What" color={c.pink}>
        <MenuField label="Kind" value={f.kind} onChange={(v) => set('kind', v)} disabled={!!id} options={KINDS.map((k) => ({ value: k.value, label: `${k.emoji}  ${k.label}` }))} />
        <Field label="Name" value={f.title} onChangeText={(x) => set('title', x)} maxLength={160} placeholder="Shown to people who register" />
        <Field label="Description (optional)" value={f.summary} onChangeText={(x) => set('summary', x)} multiline maxLength={2000} />
        <SportSelect label="Sport (optional)" value={f.sport} onChange={(v) => set('sport', v)} optional />
      </Section>
      <Section title="Who runs it" color={c.cyan}>
        <MenuField label="Organisation" value={f.organisation_id} onChange={(v) => set('organisation_id', v)} disabled={!!id} options={[{ value: '', label: 'Just me' }, ...(orgs.data ?? []).map((o) => ({ value: o.id, label: o.name }))]} hint="Owners and admins of the organisation can manage it." />
        <MenuField label={needsEvent ? 'Competition' : 'Event (optional)'} value={f.event_id} onChange={(v) => set('event_id', v)} disabled={!!id} placeholder="Choose an event" options={[...(needsEvent ? [] : [{ value: '', label: 'Not tied to an event' }]), ...(events.data ?? []).map((e) => ({ value: e.id, label: e.name, sub: e.sport }))]} hint={needsEvent ? 'Approval checks the competition\'s eligibility policy.' : undefined} />
      </Section>
      <Section title="When" color={c.sun}>
        <DateTimeField label="Opens (optional)" value={f.opens_at} onChange={(v) => set('opens_at', v)} optional />
        <DateTimeField label="Closes (optional)" value={f.closes_at} onChange={(v) => set('closes_at', v)} optional min={f.opens_at ?? undefined} />
      </Section>
      <Section title="Places and rules" color={c.mint}>
        <Toggle label="Limit the number of places" value={f.capacity != null} onChange={(on) => set('capacity', on ? 20 : null)} />
        {f.capacity != null ? <Counter label="Places" value={f.capacity} min={1} max={100000} onChange={(v) => set('capacity', v)} /> : null}
        <Toggle label="Waiting list when full" hint="People join a queue and are offered places in order. Nothing is charged while waiting." value={f.waitlist} onChange={(v) => set('waitlist', v)} />
        <Toggle label="I approve each registration" hint="Off confirms people automatically while places last." value={f.needs_approval} onChange={(v) => set('needs_approval', v)} />
        {f.kind !== 'team' ? <Toggle label="Guardians can register children" hint="Verified guardians can register the young people they look after." value={f.allow_dependents} onChange={(v) => set('allow_dependents', v)} /> : null}
        <CurrencyDropdown value={f.currency} onChange={(v) => set('currency', v)} disabled={!!id && !!p?.counts && Object.keys(p.counts).length > 0} />
        {id && choiceQs.length ? (
          <>
            <MenuField label="Limit places per answer (optional)" value={f.quotaField} onChange={(v) => setF((x) => ({ ...x, quotaField: v, limits: {} }))} options={[{ value: '', label: 'No per-answer limits' }, ...choiceQs.map((x) => ({ value: x.key, label: x.label }))]} />
            {opt ? opt.options.map((o) => (
              <View key={o.value} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <T style={{ flex: 1 }}>{o.label}</T>
                {f.limits[o.value] != null ? <Counter value={f.limits[o.value]} min={0} max={100000} onChange={(v) => set('limits', { ...f.limits, [o.value]: v })} /> : null}
                <Chip label={f.limits[o.value] != null ? 'No limit' : 'Limit'} onPress={() => { const n = { ...f.limits }; if (n[o.value] != null) delete n[o.value]; else n[o.value] = 10; set('limits', n); }} />
              </View>
            )) : null}
          </>
        ) : null}
      </Section>
      <Btn title={id ? 'Save settings' : 'Create programme'} loading={busy} disabled={!ok} onPress={save} />
    </Screen>
  );
}

const money = (text, cur) => toMinor(text, cur);
const slug = (s, taken, fallback) => { const base = (s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^[^a-z]+/, '') || fallback).slice(0, 30); let k = base, n = 2; while (taken.has(k)) k = `${base.slice(0, 26)}_${n++}`; return k; };

/** Design the questions (with conditional questions and uploads), the fees (lines, discounts, instalments) and the waivers, then publish an immutable version. */
export function RegistrationForm({ id }) {
  const { toast } = useSession();
  const { back } = useNav();
  const load = useLoad(() => api.get(`/registration-programmes/${id}`), [id]);
  const p = load.data;
  const [def, setDef] = useState({ sections: [{ id: 'details', title: 'Details', fields: [] }] });
  const [items, setItems] = useState([]);
  const [discounts, setDiscounts] = useState([]);
  const [plan, setPlan] = useState(null);
  const [waivers, setWaivers] = useState([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!p?.version) return;
    setDef(withDefaults(structuredClone(p.version.form)));
    setItems((p.version.fees.items ?? []).map((i) => ({ ...i, text: fromMinor(i.amount_cents, p.currency) })));
    setDiscounts((p.version.fees.discounts ?? []).map((d) => ({ ...d, text: d.kind === 'amount' ? fromMinor(d.value, p.currency) : String(d.value) })));
    setPlan(p.version.fees.instalments ?? null);
    setWaivers(p.version.waivers.map(({ sha256, ...w }) => w));
  }, [p?.id, p?.current_version]); // eslint-disable-line react-hooks/exhaustive-deps
  if (load.error) return <Screen><LoadError error={load.error} onRetry={load.reload} /></Screen>;
  if (load.loading && !p) return <Screen><Loading /></Screen>;
  if (!p.can_manage) return <Screen><Empty emoji="🔒" title="Only the organisers can change this" /></Screen>;
  const cur = p.currency;
  const upd = (list, setList, i, patch) => setList(list.map((x, n) => (n === i ? { ...x, ...patch } : x)));
  const publish = async () => {
    setBusy(true);
    try {
      const form = { sections: def.sections.map((s) => ({ id: s.id, title: s.title, fields: s.fields.map(strip) })) };
      const fees = {
        items: items.map((i) => ({ key: i.key, label: i.label.trim(), amount_cents: i.amount_cents ?? 0 })),
        discounts: discounts.map((d) => ({ key: d.key, label: d.label.trim(), kind: d.kind, value: d.kind === 'percent' ? Math.round(Number(d.text) || 0) : d.value, ...(d.code ? { code: d.code } : {}), ...(d.auto ? { auto: d.auto } : {}), ...(d.before ? { before: d.before } : {}), ...(d.max_uses ? { max_uses: d.max_uses } : {}) })),
        ...(plan ? { instalments: plan } : {}),
      };
      await api.post(`/registration-programmes/${id}/versions`, { expected_version: p.current_version, form, fees, waivers });
      toast('Published. New registrations use this version; existing ones keep theirs.'); back();
    } catch (e) {
      const first = Array.isArray(e.details) ? e.details[0] : null;
      toast(first ? `${first.path}: ${first.message}` : explain(e));
    } finally { setBusy(false); }
  };
  const nFields = fieldsOf(def).length;
  const canPublish = nFields > 0 && items.every((i) => i.label.trim() && i.amount_cents != null) && discounts.every((d) => d.label.trim() && (d.code || d.auto) && (d.kind === 'percent' ? Number(d.text) >= 1 && Number(d.text) <= 100 : d.value >= 1)) && waivers.every((w) => w.title.trim() && w.body.trim());
  return (
    <Screen wide>
      <H1>Form, fees and waivers</H1>
      <T size={13} color={c.mute}>{p.title} · {p.current_version ? `Publishing creates version ${p.current_version + 1}. People who already registered keep the version they used.` : 'Publish to let people register.'}</T>
      <Section title="Questions" color={c.cyan}>
        <T size={12} color={c.mute}>Short text, long text, number, amount, date, yes/no, pick one or several, and file uploads. Any question can be required, confidential (kept encrypted) or shown only when an earlier answer matches.</T>
        <DefinitionEditor def={def} onChange={setDef} types={['text', 'longtext', 'number', 'money', 'date', 'yesno', 'choice', 'multi', 'file']} />
      </Section>

      <Section title="Fees" color={c.sun}>
        {items.map((i, n) => (
          <Card key={i.key}>
            <Field label="What it covers" value={i.label} onChangeText={(x) => upd(items, setItems, n, { label: x })} maxLength={120} />
            <Field label={`Amount (${cur})`} value={i.text} keyboardType="decimal-pad" onChangeText={(x) => { const t = x.replace(/[^0-9.,]/g, ''); upd(items, setItems, n, { text: t, amount_cents: money(t, cur) }); }} accessibilityLabel="Fee amount" />
            <Btn small title="Remove" color={c.paper} ink={c.red} style={{ alignSelf: 'flex-start' }} onPress={() => setItems(items.filter((_, k) => k !== n))} />
          </Card>
        ))}
        <Btn small title="+ Add a fee" color={c.violet} style={{ alignSelf: 'flex-start' }} onPress={() => setItems([...items, { key: slug(`fee ${items.length + 1}`, new Set(items.map((x) => x.key)), 'fee'), label: '', text: '', amount_cents: undefined }])} />
        {!items.length ? <T size={12} color={c.mute}>No fees: registration is free.</T> : null}
        {items.length ? (
          <>
            <T weight="800" size={13}>Discounts</T>
            {discounts.map((d, n) => (
              <Card key={d.key}>
                <Field label="Name" value={d.label} onChangeText={(x) => upd(discounts, setDiscounts, n, { label: x })} maxLength={120} />
                <Seg options={[{ value: 'code', label: 'Code' }, { value: 'early_bird', label: 'Early bird' }, { value: 'additional_participant', label: 'Additional person' }]} value={d.auto ?? 'code'} onChange={(v) => upd(discounts, setDiscounts, n, v === 'code' ? { auto: undefined, code: d.code ?? '' } : { auto: v, code: undefined })} />
                {!d.auto ? <Field label="Code" value={d.code ?? ''} onChangeText={(x) => upd(discounts, setDiscounts, n, { code: x.toUpperCase().replace(/[^A-Z0-9_-]/g, '') })} maxLength={24} /> : null}
                {d.auto === 'early_bird' ? <DateField label="Registered on or before" value={d.before} onChange={(v) => upd(discounts, setDiscounts, n, { before: v })} /> : null}
                <Seg options={[{ value: 'percent', label: 'Percent off' }, { value: 'amount', label: `Amount off (${cur})` }]} value={d.kind} onChange={(v) => upd(discounts, setDiscounts, n, { kind: v, text: '' })} />
                <Field label={d.kind === 'percent' ? 'Percent' : `Amount (${cur})`} value={d.text} keyboardType="decimal-pad" onChangeText={(x) => { const t = x.replace(/[^0-9.,]/g, ''); upd(discounts, setDiscounts, n, d.kind === 'percent' ? { text: t, value: Math.round(Number(t) || 0) } : { text: t, value: money(t, cur) ?? 0 }); }} />
                {!d.auto ? <><T size={12} color={c.mute}>Times it can be used (optional)</T><Counter value={d.max_uses ?? 0} min={0} max={100000} onChange={(v) => upd(discounts, setDiscounts, n, { max_uses: v || undefined })} suffix={d.max_uses ? '' : ' (no limit)'} /></> : null}
                <Btn small title="Remove" color={c.paper} ink={c.red} style={{ alignSelf: 'flex-start' }} onPress={() => setDiscounts(discounts.filter((_, k) => k !== n))} />
              </Card>
            ))}
            <Btn small title="+ Add a discount" color={c.violet} style={{ alignSelf: 'flex-start' }} onPress={() => setDiscounts([...discounts, { key: slug(`discount ${discounts.length + 1}`, new Set(discounts.map((x) => x.key)), 'discount'), label: '', kind: 'percent', value: 10, text: '10', code: '' }])} />
            <Toggle label="Offer instalments" hint="People can split the total into equal payments." value={!!plan} onChange={(on) => setPlan(on ? { count: 3, interval_days: 30 } : null)} />
            {plan ? (<><Counter label="Number of payments" value={plan.count} min={2} max={12} onChange={(v) => setPlan({ ...plan, count: v })} /><Counter label="Days between payments" value={plan.interval_days} min={7} max={92} step={7} onChange={(v) => setPlan({ ...plan, interval_days: v })} /></>) : null}
          </>
        ) : null}
      </Section>

      <Section title="Consents and waivers" color={c.mint}>
        <T size={12} color={c.mute}>People sign by typing their name. The exact text is recorded with who signed and when. For a young person, a waiver can require a verified guardian.</T>
        {waivers.map((w, n) => (
          <Card key={w.key}>
            <Field label="Title" value={w.title} onChangeText={(x) => upd(waivers, setWaivers, n, { title: x })} maxLength={160} />
            <Field label="Text people agree to" value={w.body} onChangeText={(x) => upd(waivers, setWaivers, n, { body: x })} multiline maxLength={8000} />
            <Toggle label="Must be signed" value={w.required} onChange={(v) => upd(waivers, setWaivers, n, { required: v })} />
            <Toggle label="A guardian signs for a young person" value={w.guardian_required} onChange={(v) => upd(waivers, setWaivers, n, { guardian_required: v })} />
            <Btn small title="Remove" color={c.paper} ink={c.red} style={{ alignSelf: 'flex-start' }} onPress={() => setWaivers(waivers.filter((_, k) => k !== n))} />
          </Card>
        ))}
        <Btn small title="+ Add a waiver" color={c.violet} style={{ alignSelf: 'flex-start' }} onPress={() => setWaivers([...waivers, { key: slug(`waiver ${waivers.length + 1}`, new Set(waivers.map((x) => x.key)), 'waiver'), title: '', body: '', required: true, guardian_required: false }])} />
      </Section>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Btn title="Cancel" color={c.paper} ink={c.ink} onPress={back} style={{ flex: 1 }} />
        <Btn title={p.current_version ? 'Publish new version' : 'Publish'} loading={busy} disabled={!canPublish} onPress={publish} style={{ flex: 2 }} />
      </View>
    </Screen>
  );
}
