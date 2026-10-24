// Programmes: a catalogue with live seat health, a step-by-step builder (basics, audience, admission, pricing with a payment preview,
// application questions, agreements, review) and a programme desk (groups, roster, waitlist, terms history, agreements, money).
import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Chip, Empty, ErrorBox, Field, Loading, Row, Seg, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { EntityPicker } from '../entity-picker';
import { Stepper } from '../pickers';
import { c } from '../theme';
import { moneyIn } from '../vtime';
import { explain } from '../access';
import { useLayout } from '../layout';
import { BILLING, Block, FOCUS, FORMATS, Fact, Initials, MODES, MODE_HELP, Meter, StageBadge, Timeline, lab, opts, priceLine, when } from './academy-ui';

export function Programmes({ o, archived, toast, onOpenApplication }) {
  const list = useLoad(() => api.get(`/organisations/${o.id}/academy/programmes`, { limit: 100 }), [o.id]);
  const [open, setOpen] = useState(null), [build, setBuild] = useState(false), [status, setStatus] = useState('live');
  const { tablet } = useLayout();
  if (open) return <Desk o={o} id={open} archived={archived} toast={toast} onBack={() => { setOpen(null); list.reload(); }} onOpenApplication={onOpenApplication} />;
  const all = list.data ?? [];
  const shown = all.filter((p) => (status === 'live' ? ['published', 'draft'].includes(p.status) : status === 'closed' ? ['closed', 'archived'].includes(p.status) : true));
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <View style={{ flex: 1, minWidth: 220 }}><Seg value={status} onChange={setStatus} color={c.violet} options={[{ value: 'live', label: 'Open & drafts' }, { value: 'closed', label: 'Closed' }, { value: 'all', label: 'All' }]} /></View>
        {!archived ? <Btn small title="＋ New programme" onPress={() => setBuild(true)} /> : null}
      </View>
      {list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !list.data ? <Loading /> : !shown.length ? (
        <Empty emoji="🏅" title="No programmes yet" sub="A programme is what you sell: a squad, a term course, a camp. Build one step by step, then publish its price." />
      ) : (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
          {shown.map((p) => (
            <Pressable key={p.id} onPress={() => setOpen(p.id)} accessibilityRole="button" accessibilityLabel={`${p.title}, ${p.status}, ${p.enrolled} enrolled`} style={{ width: tablet ? '48.5%' : '100%', backgroundColor: c.paper, borderRadius: 18, padding: 16, gap: 8, borderWidth: 1, borderColor: c.line }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><T weight="800" size={16} style={{ flex: 1 }}>{p.title}</T><Tag label={p.status === 'published' ? `Live · v${p.current_version}` : p.status} color={p.status === 'published' ? c.lime : undefined} /></View>
              <T size={13} color={c.mute}>{lab(FORMATS, p.format)} · {p.sport}{p.age_min != null ? ` · ages ${p.age_min}–${p.age_max ?? '+'}` : ''} · {lab(FOCUS, p.focus)}</T>
              {p.starts_on ? <T size={13} color={c.mute}>📅 {when(p.starts_on)}{p.ends_on ? ` – ${when(p.ends_on)}` : ''}{p.cadence ? ` · ${p.cadence}` : ''}</T> : null}
              <Meter filled={p.enrolled} held={Math.max(0, p.seats_taken - p.enrolled)} capacity={p.capacity} waitlisted={p.waitlisted} />
              <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}><Tag label={lab(MODES, p.admission_mode)} />{p.trial_enabled ? <Tag label="Trial" /> : null}{p.public ? <Tag label="Public" /> : <Tag label="Private" />}</View>
            </Pressable>
          ))}
        </View>
      )}
      {build ? <Builder o={o} onClose={() => setBuild(false)} onDone={() => { setBuild(false); list.reload(); }} toast={toast} /> : null}
    </View>
  );
}

// ------------------------------------------------------------------ builder
const money = (m, cur) => moneyIn(m, cur);
/** Mirrors the server's split so people see the real plan before publishing; the family sees the server's exact quote. */
export function preview(v) {
  const fee = Number(v.fee_minor ?? 0), reg = Number(v.registration_fee_minor ?? 0), dep = Math.min(Number(v.deposit_minor ?? 0), fee), n = Math.max(1, Number(v.instalments ?? 1));
  const rows = [];
  if (reg) rows.push(['Joining fee', reg, 0]);
  if (v.billing_model === 'term' && n > 1) {
    const rest = fee - dep; let given = 0;
    if (dep) rows.push(['Deposit', dep, 0]);
    for (let i = 0; i < n; i++) { const upTo = Math.round((rest * (i + 1)) / n); rows.push([`Instalment ${i + 1} of ${n}`, upTo - given, i + (dep ? 1 : 0)]); given = upTo; }
  } else if (v.billing_model !== 'free' && fee) rows.push([v.billing_model === 'monthly' ? 'First month' : v.billing_model === 'pack' ? `${v.sessions_in_pack ?? ''} session pack` : 'Fee', fee, 0]);
  return rows;
}

const STEPS = ['Basics', 'Audience', 'Admission', 'Pricing', 'Questions', 'Review'];
export function Builder({ o, programme, onClose, onDone, toast: _t }) {
  const { toast } = useSession();
  const [step, setStep] = useState(programme ? 3 : 0);
  const prof = useLoad(() => api.get(`/organisations/${o.id}/academy`).catch(() => null), [o.id]);
  const seasons = useLoad(() => api.get(`/organisations/${o.id}/seasons`).catch(() => []), [o.id]);
  const policies = useLoad(() => api.get(`/organisations/${o.id}/policies`).catch(() => []), [o.id]);
  const [v, setV] = useState(programme ? { ...programme, billing_model: 'one_time', currency: prof.data?.currency ?? 'GBP' } : { format: 'term_course', focus: 'development', admission_mode: 'direct', waitlist_enabled: true, billing_model: 'one_time', instalments: 1, offer_valid_hours: 72, questions: [], policy_version_ids: [], public: false, trial_enabled: false });
  const cur = v.currency ?? prof.data?.currency ?? 'GBP';
  const [busy, setBusy] = useState(false);
  const next = (patch) => { setV((x) => ({ ...x, ...patch })); setStep((s) => s + 1); };
  const back = () => setStep((s) => Math.max(programme ? 3 : 0, s - 1));
  const save = async (publish) => {
    setBusy(true);
    try {
      const body = { sport: v.sport, title: v.title, description: v.description, format: v.format, focus: v.focus, age_min: v.age_min, age_max: v.age_max, starts_on: v.starts_on, ends_on: v.ends_on, cadence: v.cadence, session_minutes: v.session_minutes, sessions_planned: v.sessions_planned,
        season_id: v.season_id, capacity: v.capacity, admission_mode: v.admission_mode, waitlist_enabled: v.waitlist_enabled, trial_enabled: v.trial_enabled, public: v.public, equipment: v.equipment };
      let p = programme;
      if (!p) p = await api.post(`/organisations/${o.id}/academy/programmes`, Object.fromEntries(Object.entries(body).filter(([, x]) => x !== undefined && x !== '')));
      if (publish) {
        const pc = (k) => Math.round((v[k] ?? 0) * 100);
        await api.post(`/academy/programmes/${p.id}/versions`, { row_version: p.row_version, billing_model: v.billing_model, currency: cur, fee_minor: v.fee_minor ?? 0, registration_fee_minor: v.registration_fee_minor ?? 0, trial_fee_minor: v.trial_fee_minor ?? 0, deposit_minor: v.deposit_minor ?? 0, instalments: v.billing_model === 'term' ? v.instalments : 1,
          sessions_in_pack: v.billing_model === 'pack' ? v.sessions_in_pack ?? 10 : undefined, sibling_discount_bp: pc('sibling_pct'), multi_programme_discount_bp: pc('multi_pct'), offer_valid_hours: v.offer_valid_hours, renewal_terms: v.renewal_terms || undefined, questions: v.questions ?? [], policy_version_ids: v.policy_version_ids ?? [] });
      }
      toast(publish ? 'Published — families can apply' : 'Saved as a draft');
      onDone();
    } catch (e) { toast(explain(e)); } finally { setBusy(false); }
  };
  const rows = preview({ ...v, currency: cur });
  return (
    <Sheet visible onClose={onClose} title={programme ? `New terms · ${programme.title}` : 'New programme'}>
      <Stepper steps={programme ? STEPS.slice(3) : STEPS} current={programme ? step - 3 : step} onJump={(i) => setStep(i + (programme ? 3 : 0))} />
      {step === 0 ? <FormSheet inline visible initial={v} submitLabel="Next: audience" onClose={() => {}} fields={[
        { key: 'title', label: 'Programme name' }, { key: 'sport', label: 'Sport', type: 'sport' },
        { key: 'format', label: 'What kind of programme is it?', type: 'chips', options: opts(FORMATS) },
        { key: 'focus', label: 'Level', type: 'chips', options: opts(FOCUS) },
        { key: 'description', label: 'What families will read', type: 'multiline', optional: true, hint: 'Say what a session looks like and who it is for.' },
        { key: 'season_id', label: 'Season', type: 'chips', optional: true, options: (seasons.data ?? []).map((s) => ({ value: s.id, label: s.name })), hint: 'Optional. Seasons are managed under Cohorts.' }]} onSubmit={async (x) => next(x)} /> : null}
      {step === 1 ? <FormSheet inline visible initial={v} submitLabel="Next: admission" onBack={back} onClose={() => {}} fields={[
        { key: 'age_min', label: 'Youngest age', type: 'stepper', min: 0, max: 99, default: 8, optional: true }, { key: 'age_max', label: 'Oldest age', type: 'stepper', min: 0, max: 99, default: 12, optional: true },
        { key: 'starts_on', label: 'Runs', type: 'daterange', toKey: 'ends_on', optional: true },
        { key: 'cadence', label: 'How often', type: 'chips', optional: true, options: ['Daily', 'Twice a week', 'Weekly', 'Weekends', 'Intensive week'] },
        { key: 'session_minutes', label: 'Session length (minutes)', type: 'stepper', min: 15, max: 300, step: 15, default: 60, optional: true },
        { key: 'sessions_planned', label: 'Sessions planned', type: 'stepper', min: 1, max: 200, default: 20, optional: true, hint: 'Intent only. The timetable is built in the academy schedule.' }]} onSubmit={async (x) => next(x)} /> : null}
      {step === 2 ? <FormSheet inline visible initial={v} submitLabel="Next: pricing" onBack={back} onClose={() => {}} fields={[
        { key: 'capacity', label: 'Places', type: 'stepper', min: 1, max: 500, default: 20, hint: 'Seats are held when an offer is made and released if it expires.' },
        { key: 'admission_mode', label: 'How do people join?', type: 'chips', options: opts(MODES), hint: MODE_HELP[v.admission_mode] },
        { key: 'trial_enabled', label: 'Offer a trial', type: 'switch' }, { key: 'waitlist_enabled', label: 'Use a waitlist when full', type: 'switch' },
        { key: 'offer_valid_hours', label: 'Offers stay open (hours)', type: 'stepper', min: 1, max: 720, step: 12 },
        { key: 'public', label: 'Show in public discovery', type: 'switch', hint: 'Also needs your academy profile to be listed.' }]} onSubmit={async (x) => next(x)} /> : null}
      {step === 3 ? (
        <View style={{ gap: 12 }}>
          <FormSheet inline visible initial={{ ...v, currency: cur }} submitLabel="Next: questions" onBack={programme ? undefined : back} onClose={() => {}} fields={[
            { key: 'billing_model', label: 'How is it paid?', type: 'chips', options: opts(BILLING) },
            { key: 'currency', label: 'Currency', type: 'currency' },
            { key: 'fee_minor', label: 'Fee', type: 'money', currency: (x) => x.currency, show: (x) => x.billing_model !== 'free' },
            { key: 'registration_fee_minor', label: 'Joining fee', type: 'money', currency: (x) => x.currency, optional: true, show: (x) => x.billing_model !== 'free' },
            { key: 'deposit_minor', label: 'Deposit', type: 'money', currency: (x) => x.currency, optional: true, show: (x) => x.billing_model === 'term' },
            { key: 'instalments', label: 'Instalments', type: 'stepper', min: 1, max: 24, show: (x) => x.billing_model === 'term' },
            { key: 'sessions_in_pack', label: 'Sessions in the pack', type: 'stepper', min: 1, max: 200, default: 10, show: (x) => x.billing_model === 'pack' },
            { key: 'trial_fee_minor', label: 'Trial fee', type: 'money', currency: (x) => x.currency, optional: true, show: (x) => x.trial_enabled },
            { key: 'sibling_pct', label: 'Sibling discount (%)', type: 'stepper', min: 0, max: 100, step: 5, default: 0, hint: 'The better of the sibling and second-programme discounts applies, never both.' },
            { key: 'multi_pct', label: 'Second-programme discount (%)', type: 'stepper', min: 0, max: 100, step: 5, default: 0 },
            { key: 'renewal_terms', label: 'Renewal terms', type: 'multiline', optional: true }]} onSubmit={async (x) => next(x)} />
          {rows.length ? (
            <Block title="What a family will pay (preview)">
              {rows.map(([l, a, m]) => <View key={l} style={{ flexDirection: 'row' }}><T size={13} style={{ flex: 1 }}>{l}{m ? ` · +${m} month${m > 1 ? 's' : ''}` : ' · on enrolment'}</T><T size={13} weight="800">{money(a, cur)}</T></View>)}
              <T size={11} color={c.mute}>Families see the exact quote, with any sibling discount, before they apply. Nothing is charged automatically.</T>
            </Block>
          ) : null}
        </View>
      ) : null}
      {step === 4 ? <Questions v={v} setV={setV} policies={policies.data ?? []} onBack={programme ? () => setStep(3) : back} onNext={() => setStep(5)} /> : null}
      {step === 5 ? (
        <View style={{ gap: 10 }}>
          <Block title="Review">
            <Fact k="Programme" v={v.title} /><Fact k="Format" v={`${lab(FORMATS, v.format)} · ${lab(FOCUS, v.focus)}`} /><Fact k="Sport" v={v.sport} />
            <Fact k="Ages" v={v.age_min != null ? `${v.age_min}–${v.age_max ?? '+'}` : 'Any'} /><Fact k="Runs" v={v.starts_on ? `${when(v.starts_on)}${v.ends_on ? ` – ${when(v.ends_on)}` : ''}` : 'Rolling'} />
            <Fact k="Places" v={v.capacity ?? 'No limit'} /><Fact k="Joining" v={lab(MODES, v.admission_mode)} />
            <Fact k="Billing" v={`${lab(BILLING, v.billing_model)}${v.billing_model !== 'free' ? ` · ${money(v.fee_minor ?? 0, cur)}` : ''}`} />
            <Fact k="Questions" v={`${(v.questions ?? []).length} · ${(v.policy_version_ids ?? []).length} agreements`} />
          </Block>
          <T size={12} color={c.mute}>Publishing freezes these terms as a version. Later changes create a new version; people who already accepted keep the version they saw.</T>
          <Btn title="Publish and open for applications" onPress={() => save(true)} loading={busy} />
          {!programme ? <Btn title="Save as draft" color={c.paper} ink={c.ink} onPress={() => save(false)} loading={busy} /> : null}
          <Btn title="Back" color={c.paper} ink={c.ink} onPress={back} />
        </View>
      ) : null}
    </Sheet>
  );
}

const QTYPES = [['text', 'Short text'], ['longtext', 'Long text'], ['number', 'Number'], ['yesno', 'Yes / no'], ['choice', 'Pick one'], ['date', 'Date']];
function Questions({ v, setV, policies, onBack, onNext }) {
  const [add, setAdd] = useState(false);
  const qs = v.questions ?? [];
  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^[^a-z]+/, 'q').slice(0, 36) || 'question';
  return (
    <View style={{ gap: 10 }}>
      <Block title="Application questions" right={<Btn small title="＋ Add" color={c.paper} ink={c.ink} onPress={() => setAdd(true)} />}>
        <T size={12} color={c.mute}>Keep it to what you need to decide. Health and medical questions are not allowed here: those stay with guardian-consented health records.</T>
        {qs.length ? qs.map((q, i) => (
          <Row key={q.key} title={q.label} sub={`${lab(QTYPES, q.type)}${q.required ? ' · required' : ''}${q.options ? ` · ${q.options.join(', ')}` : ''}`} right={<Btn small title="Remove" color={c.paper} ink={c.ink} onPress={() => setV((x) => ({ ...x, questions: x.questions.filter((_, j) => j !== i) }))} />} />
        )) : <T size={13} color={c.mute}>No questions: people just confirm and apply.</T>}
      </Block>
      <Block title="Agreements people must acknowledge">
        {policies.length ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{policies.map((p) => { const on = (v.policy_version_ids ?? []).includes(p.version_id); return <Chip key={p.id} label={`${p.title} v${p.current_version}`} active={on} onPress={() => setV((x) => ({ ...x, policy_version_ids: on ? x.policy_version_ids.filter((y) => y !== p.version_id) : [...(x.policy_version_ids ?? []), p.version_id] }))} />; })}</View> : <T size={13} color={c.mute}>No agreements yet. Add them under Agreements, then require them here.</T>}
      </Block>
      <View style={{ flexDirection: 'row', gap: 8 }}><Btn title="Back" color={c.paper} ink={c.ink} onPress={onBack} style={{ flex: 1 }} /><Btn title="Next: review" onPress={onNext} style={{ flex: 2 }} /></View>
      <FormSheet visible={add} onClose={() => setAdd(false)} title="Add a question" submitLabel="Add" initial={{ type: 'text', required: false }} fields={[
        { key: 'label', label: 'Question' }, { key: 'type', label: 'Answer type', type: 'chips', options: opts(QTYPES) },
        { key: 'options_text', label: 'Choices (comma separated)', show: (x) => x.type === 'choice' }, { key: 'required', label: 'Required', type: 'switch' }]}
        onSubmit={async (x) => { const options = x.type === 'choice' ? String(x.options_text ?? '').split(',').map((s) => s.trim()).filter(Boolean) : undefined; if (x.type === 'choice' && options.length < 2) throw new Error('Give at least two choices'); setV((p) => ({ ...p, questions: [...(p.questions ?? []), { key: slug(x.label) + (qs.some((q) => q.key === slug(x.label)) ? `_${qs.length + 1}` : ''), label: x.label, type: x.type, required: !!x.required, ...(options ? { options } : {}) }] })); }} />
    </View>
  );
}

// ------------------------------------------------------------------ programme desk
const TABS = [['overview', 'Overview'], ['groups', 'Groups'], ['roster', 'Roster'], ['waitlist', 'Waitlist'], ['terms', 'Terms'], ['agreements', 'Agreements']];
function Desk({ o, id, archived, toast, onBack, onOpenApplication }) {
  const d = useLoad(() => api.get(`/academy/programmes/${id}/desk`), [id]);
  const [tab, setTab] = useState('overview');
  const [terms, setTerms] = useState(false), [group, setGroup] = useState(false), [invite, setInvite] = useState(false), [who, setWho] = useState([]), [edit, setEdit] = useState(null);
  const members = useLoad(() => api.get(`/organisations/${o.id}/members`).catch(() => []), [o.id]);
  if (d.error) return <View style={{ gap: 8 }}><Btn small title="← Programmes" color={c.paper} ink={c.ink} onPress={onBack} style={{ alignSelf: 'flex-start' }} /><ErrorBox error={d.error} onRetry={d.reload} /></View>;
  if (!d.data) return <Loading />;
  const { programme: p, versions, groups, roster, waitlist, offers, seats, policies, stages, money: mny, my_role } = d.data;
  const staff = my_role === 'owner' || my_role === 'admin';
  const act = async (fn, msg) => { try { await fn(); toast(msg); } catch (e) { toast(explain(e)); } finally { d.reload(); } };
  const cur = versions[0];
  return (
    <View style={{ gap: 12 }}>
      <Btn small title="← Programmes" color={c.paper} ink={c.ink} onPress={onBack} style={{ alignSelf: 'flex-start' }} />
      <View style={{ gap: 4 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}><T weight="800" size={22} style={{ letterSpacing: -0.5 }}>{p.title}</T><Tag label={p.status === 'published' ? `Live · v${p.current_version}` : p.status} color={p.status === 'published' ? c.lime : undefined} /></View>
        <T color={c.mute}>{lab(FORMATS, p.format)} · {p.sport} · {lab(FOCUS, p.focus)}{p.age_min != null ? ` · ages ${p.age_min}–${p.age_max ?? '+'}` : ''}{p.starts_on ? ` · ${when(p.starts_on)}${p.ends_on ? ` – ${when(p.ends_on)}` : ''}` : ''}</T>
      </View>
      <Meter filled={seats.enrolled} held={seats.offers_held} capacity={p.capacity} waitlisted={seats.waitlisted} />
      {staff && !archived ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <Btn small title={cur ? 'Publish new terms' : 'Publish terms'} onPress={() => setTerms(true)} />
          <Btn small title="Invite an athlete" color={c.paper} ink={c.ink} onPress={() => setInvite(true)} />
          <Btn small title="Add a group" color={c.paper} ink={c.ink} onPress={() => setGroup(true)} />
          {seats.waitlisted && seats.free ? <Btn small title={`Offer ${Math.min(seats.free, seats.waitlisted)} place${Math.min(seats.free, seats.waitlisted) > 1 ? 's' : ''} from the waitlist`} color={c.paper} ink={c.ink} onPress={() => act(() => api.post(`/academy/programmes/${id}/waitlist/promote`), 'Offers sent')} /> : null}
          {p.status !== 'closed' && p.status !== 'archived' ? <Btn small title="Close applications" color={c.paper} ink={c.ink} onPress={() => act(() => api.patch(`/academy/programmes/${id}`, { row_version: p.row_version, status: 'closed' }), 'Closed to new applications')} /> : null}
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{TABS.map(([k, l]) => <Chip key={k} label={k === 'roster' ? `${l} (${roster.length})` : k === 'waitlist' ? `${l} (${waitlist.length})` : l} active={tab === k} onPress={() => setTab(k)} />)}</View>
      {tab === 'overview' ? (
        <View style={{ gap: 12 }}>
          <Block title="Where applications stand">
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{stages.map((s) => <Tag key={s.stage} label={`${s.n} ${s.stage.replace(/_/g, ' ')}`} />)}{!stages.length ? <T size={13} color={c.mute}>No applications yet.</T> : null}</View>
            {offers.length ? offers.map((x) => <Row key={x.application_id} title={`${x.display_name} — offer pending`} sub={x.offer_expires_at ? `answer by ${when(x.offer_expires_at)}` : ''} onPress={() => onOpenApplication?.(x.application_id)} />) : null}
          </Block>
          <Block title="Terms in force">{cur ? <><Fact k="Price" v={priceLine(cur)} />{cur.registration_fee_minor > 0 ? <Fact k="Joining fee" v={moneyIn(cur.registration_fee_minor, cur.currency)} /> : null}{cur.deposit_minor > 0 ? <Fact k="Deposit" v={moneyIn(cur.deposit_minor, cur.currency)} /> : null}<Fact k="Discounts" v={cur.sibling_discount_bp || cur.multi_programme_discount_bp ? `${cur.sibling_discount_bp / 100}% sibling · ${cur.multi_programme_discount_bp / 100}% second programme` : 'None'} /><Fact k="Joining" v={lab(MODES, p.admission_mode)} /><Fact k="Offers open" v={`${cur.offer_valid_hours} hours`} /></> : <T size={13} color={c.mute}>Not published yet. Publish terms to open the programme.</T>}</Block>
          {mny.length ? <Block title="Money (this programme)">{mny.map((m) => <T key={m.currency} size={13}>{m.currency}: billed {moneyIn(m.billed_minor, m.currency)} · customers paid {moneyIn(m.paid_minor, m.currency)} · outstanding {moneyIn(m.outstanding_minor, m.currency)}</T>)}</Block> : null}
        </View>
      ) : null}
      {tab === 'groups' ? (
        <Block title="Groups & capacity">
          {groups.length ? groups.map((g) => <View key={g.id} style={{ padding: 12, borderRadius: 14, backgroundColor: c.paper, borderWidth: 1, borderColor: c.line, gap: 6 }}><View style={{ flexDirection: 'row' }}><T weight="800" style={{ flex: 1 }}>{g.name}</T><T size={12} color={c.mute}>{g.coach_name ? `Coach ${g.coach_name}` : 'No coach yet'}</T></View><Meter filled={g.enrolled} capacity={g.capacity} compact /></View>) : <Empty emoji="👥" title="No groups yet" sub="Athletes who enrol are placed in a group. One is created automatically, or add your own with a coach and capacity." />}
        </Block>
      ) : null}
      {tab === 'roster' ? (
        <Block title="Enrolled athletes">
          {roster.length ? roster.map((r) => (
            <Row key={r.enrolment_id} left={<Initials user={r} size={36} />} title={r.display_name} sub={`${r.group_name}${r.sessions_left != null ? ` · ${r.sessions_left} sessions left` : ''} · since ${when(r.enrolled_at)}`}
              right={<View style={{ alignItems: 'flex-end', gap: 4 }}>{r.status === 'paused' ? <Tag label="Paused" /> : null}{r.overdue ? <Tag label="Payment overdue" color={c.orangeSoft} /> : null}</View>} onPress={staff && !archived ? () => setEdit(r) : undefined} />
          )) : <Empty emoji="🏅" title="No one enrolled yet" />}
        </Block>
      ) : null}
      {tab === 'waitlist' ? (
        <Block title="Waitlist, in order">
          <T size={12} color={c.mute}>People are offered places in this order. Position is honest: it counts only who is ahead, with no promised date.</T>
          {waitlist.length ? waitlist.map((w, i) => <Row key={w.application_id} left={<T weight="800" size={18} style={{ width: 28 }}>{i + 1}</T>} title={w.display_name} sub={`joined ${when(w.created_at)}${w.via_guardian ? ` · via ${w.applicant_name}` : ''}`} right={staff && !archived ? <Btn small title="Offer a place" color={c.paper} ink={c.ink} onPress={() => act(() => api.post(`/academy/applications/${w.application_id}/decision`, { row_version: w.row_version, decision: 'offer' }), 'Offer sent')} /> : undefined} onPress={() => onOpenApplication?.(w.application_id)} />) : <Empty emoji="⏳" title="No one is waiting" />}
        </Block>
      ) : null}
      {tab === 'terms' ? (
        <Block title="Version history">
          <T size={12} color={c.mute}>Each published version is frozen. People are charged under the version they accepted.</T>
          <Timeline items={versions.map((x) => ({ title: `Version ${x.version} · ${priceLine(x)}`, sub: `${when(x.created_at)} · ${x.enrolled_under} enrolled, ${x.open_under} in progress under this version${x.version === p.current_version ? ' · current' : ''}` }))} />
          {!versions.length ? <T size={13} color={c.mute}>Nothing published yet.</T> : null}
        </Block>
      ) : null}
      {tab === 'agreements' ? (
        <Block title="Required agreements">
          {policies.length ? policies.map((x) => <Row key={x.version_id} title={`${x.title} · v${x.version}`} sub={`${x.acknowledged} acknowledged`} />) : <T size={13} color={c.mute}>This programme requires no agreements.</T>}
        </Block>
      ) : null}
      {terms ? <Builder o={o} programme={{ ...p, row_version: p.row_version }} onClose={() => setTerms(false)} onDone={() => { setTerms(false); d.reload(); }} toast={toast} /> : null}
      <FormSheet visible={group} onClose={() => setGroup(false)} title="Add a group" submitLabel="Create group" fields={[
        { key: 'name', label: 'Group name' }, { key: 'capacity', label: 'Places in this group', type: 'stepper', min: 1, max: 500, default: 12, optional: true },
        { key: 'coach_id', label: 'Coach', type: 'chips', optional: true, options: (members.data ?? []).filter((m) => ['owner', 'admin', 'coach'].includes(m.org_role)).map((m) => ({ value: m.id ?? m.user_id, label: m.display_name })) }]}
        onSubmit={async (x) => { await api.post(`/organisations/${o.id}/cohorts`, { ...x, programme_id: id, season_id: p.season_id ?? undefined }); d.reload(); return 'Group added'; }} />
      <Sheet visible={invite} onClose={() => { setInvite(false); setWho([]); }} title="Invite an athlete">
        <View style={{ gap: 10 }}>
          <EntityPicker label="Athlete" value={who} onChange={setWho} />
          <T size={12} color={c.mute}>A place is held for them while the offer is open. For a child, their guardian answers the offer.</T>
          <Btn title="Send invitation" disabled={!who.length} onPress={async () => { try { await api.post(`/academy/programmes/${id}/invitations`, { person: who[0].sub.replace(/^@/, '') }); toast('Invitation sent'); setInvite(false); setWho([]); } catch (e) { toast(explain(e)); } finally { d.reload(); } }} />
        </View>
      </Sheet>
      <Sheet visible={!!edit} onClose={() => setEdit(null)} title={edit?.display_name ?? ''}>
        {edit ? (
          <View style={{ gap: 10 }}>
            <T color={c.mute}>{edit.group_name} · {edit.status}</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {edit.status === 'enrolled' ? <Btn small title="Pause" color={c.paper} ink={c.ink} onPress={() => act(() => api.post(`/academy-enrolments/${edit.enrolment_id}/status`, { status: 'paused' }), 'Paused').then(() => setEdit(null))} /> : <Btn small title="Resume" onPress={() => act(() => api.post(`/academy-enrolments/${edit.enrolment_id}/status`, { status: 'enrolled' }), 'Resumed').then(() => setEdit(null))} />}
              <Btn small title="Mark completed" color={c.paper} ink={c.ink} onPress={() => act(() => api.post(`/academy-enrolments/${edit.enrolment_id}/status`, { status: 'completed' }), 'Completed').then(() => setEdit(null))} />
              <Btn small title="Graduate" color={c.paper} ink={c.ink} onPress={() => act(() => api.post(`/academy-enrolments/${edit.enrolment_id}/status`, { status: 'graduated' }), 'Graduated').then(() => setEdit(null))} />
              <Btn small title="Withdraw" color={c.orange} onPress={() => act(() => api.post(`/academy-enrolments/${edit.enrolment_id}/status`, { status: 'withdrawn', reason: 'Withdrawn by academy' }), 'Withdrawn — history kept').then(() => setEdit(null))} />
            </View>
            {groups.filter((g) => g.id !== edit.cohort_id && g.status === 'active').length ? <><T weight="800" size={13}>Move to another group</T><View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{groups.filter((g) => g.id !== edit.cohort_id && g.status === 'active').map((g) => <Chip key={g.id} label={`${g.name} (${g.enrolled}${g.capacity ? `/${g.capacity}` : ''})`} onPress={() => act(() => api.post(`/academy-enrolments/${edit.enrolment_id}/transfer`, { to_cohort_id: g.id }), 'Moved').then(() => setEdit(null))} />)}</View></> : null}
            <T size={12} color={c.mute}>Pausing is an enrolment status only: no health reason is recorded here. Nothing is deleted.</T>
          </View>
        ) : null}
      </Sheet>
    </View>
  );
}
