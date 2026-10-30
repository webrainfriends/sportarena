import React, { useEffect, useRef, useState } from 'react';
import { Platform, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Btn, Card, Chip, Empty, Field, H1, Loading, Screen, Section, Seg, Sheet, T, Tag } from '../ui';
import { MenuField } from '../menu-field';
import { PaySheet } from '../PaySheet';
import { c } from '../theme';
import { explain, LoadError } from '../access';
import { fieldsOf, filled, fmtMoney, newKey, stepOfIssue, visibleKeys } from '../application-forms';
import { Question } from './sponsor-application';

/** One registration framework for every scenario: these are the kinds a programme can be (mirrors the server's KINDS). */
export const KINDS = [
  { value: 'athlete', label: 'Athlete registration', emoji: '🏃' }, { value: 'team', label: 'Team registration', emoji: '🛡️' }, { value: 'event', label: 'Event entry', emoji: '🎟️' },
  { value: 'competition', label: 'Competition registration', emoji: '🏆' }, { value: 'membership', label: 'Membership', emoji: '🪪' }, { value: 'course', label: 'Course or camp', emoji: '🏕️' },
  { value: 'licence', label: 'Federation licence', emoji: '📜' },
];
export const kindOf = (k) => KINDS.find((x) => x.value === k) ?? KINDS[0];
const STATUS = {
  draft: ['Draft', c.violetSoft], submitted: ['Submitted', c.sunSoft], under_review: ['Under review', c.sunSoft], info_requested: ['More information needed', c.pinkSoft], waitlisted: ['Waiting list', c.cyanSoft],
  approved: ['Confirmed', c.limeSoft], suspended: ['Suspended', c.pinkSoft], expired: ['Expired', c.violetSoft], rejected: ['Declined', c.pinkSoft], withdrawn: ['Withdrawn', c.violetSoft], cancelled: ['Cancelled', c.violetSoft],
};
export const StatusTag = ({ status }) => <Tag label={(STATUS[status] ?? [status])[0]} color={(STATUS[status] ?? [])[1] ?? c.violetSoft} />;
const day = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const stamp = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const REASON = { closed: 'Closed', not_yet_open: 'Not open yet', deadline_passed: 'Deadline passed' };

/** Where a mirrored registration is really managed (stage A of the consolidation): the engine shows it, its own module still decides it. */
export const MANAGED = {
  roster_registration: { label: 'the event console', screen: (m) => ['EventCommand', { id: m.event_id, tab: 'registration' }] },
  academy_application: { label: 'academy admissions', screen: (m) => ['AcademyPage', { id: m.organisation_id }] },
};
export function ManagedBanner({ managed }) {
  const { push } = useNav();
  const m = MANAGED[managed?.kind];
  if (!m) return null;
  return (
    <Card color={c.cyanSoft}>
      <T weight="900">Managed in {m.label}</T>
      <T size={13}>This registration is shown here so everything is in one place. Decisions, changes and payments are made in {m.label}.</T>
      <Btn small title={`Open ${m.label}`} color={c.violet} style={{ alignSelf: 'flex-start' }} onPress={() => push(...m.screen(managed))} />
    </Card>
  );
}

export function places(a) {
  if (!a) return '';
  if (!a.accepting) return REASON[a.reason] ?? 'Closed';
  if (a.seats_left == null) return 'Open';
  return a.seats_left > 0 ? `${a.seats_left} place${a.seats_left === 1 ? '' : 's'} left` : a.waitlist_open ? 'Full · waiting list open' : 'Full';
}

function ProgrammeCard({ p, onPress }) {
  const k = kindOf(p.kind);
  return (
    <Card onPress={onPress} accessibilityLabel={`${p.title}. ${k.label}. ${places(p.availability)}`}>
      <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
        <T size={26}>{k.emoji}</T>
        <View style={{ flex: 1 }}>
          <T weight="900" numberOfLines={2}>{p.title}</T>
          <T size={12} color={c.mute}>{[k.label, p.organisation_name, p.sport].filter(Boolean).join(' · ')}</T>
        </View>
        <Tag label={places(p.availability)} color={p.availability?.accepting ? c.limeSoft : c.violetSoft} />
      </View>
      {p.closes_at ? <T size={12} color={c.mute} style={{ marginTop: 6 }}>Closes {day(p.closes_at)}</T> : null}
    </Card>
  );
}

/** Find something to register for, see what you have registered, and (if you run any) the programmes you manage. */
export function RegistrationHome({ tab: first = 'find' }) {
  const { push } = useNav();
  const [tab, setTab] = useState(first);
  const [kind, setKind] = useState('');
  const [q, setQ] = useState('');
  const list = useLoad(() => api.get('/registration-programmes', { scope: 'open', ...(kind ? { kind } : {}), ...(q.trim() ? { q: q.trim() } : {}), limit: 50 }), [kind, q]);
  const mine = useLoad(() => api.get('/me/registration-entries', { limit: 50 }), []);
  const run = useLoad(() => api.get('/registration-programmes', { scope: 'managed', limit: 50 }), []);
  const cur = tab === 'find' ? list : tab === 'mine' ? mine : run;
  return (
    <Screen onRefresh={cur.reload} refreshing={cur.loading && !!cur.data} wide>
      <H1>Registration</H1>
      <T size={13} color={c.mute}>Athletes, teams, events, competitions, memberships, courses and licences all register the same way here.</T>
      <Seg options={[{ value: 'find', label: 'Find' }, { value: 'mine', label: 'My registrations' }, { value: 'run', label: 'I run' }]} value={tab} onChange={setTab} />
      {tab === 'find' ? (
        <>
          <MenuField label="Kind" value={kind} onChange={setKind} options={[{ value: '', label: 'Everything' }, ...KINDS.map((k) => ({ value: k.value, label: `${k.emoji}  ${k.label}` }))]} />
          <Field label="Search" value={q} onChangeText={setQ} placeholder="Name, sport or place" maxLength={80} accessibilityLabel="Search registrations" />
        </>
      ) : null}
      {cur.error ? <LoadError error={cur.error} onRetry={cur.reload} /> : cur.loading && !cur.data ? <Loading /> : null}
      {tab === 'find' && list.data ? (list.data.length ? list.data.map((p) => <ProgrammeCard key={p.id} p={p} onPress={() => push('RegistrationApply', { id: p.id })} />) : <Empty emoji="🔎" title="Nothing open right now" sub="Open registrations from clubs, federations and organisers appear here." />) : null}
      {tab === 'mine' && mine.data ? (mine.data.length ? mine.data.map((e) => (
        <Card key={e.id} onPress={() => push('RegistrationEntry', { id: e.id })} accessibilityLabel={`${e.programme_title}, ${(STATUS[e.status] ?? [e.status])[0]}`}>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><T size={22}>{kindOf(e.kind).emoji}</T><T weight="900" style={{ flex: 1 }} numberOfLines={2}>{e.programme_title}</T><StatusTag status={e.status} /></View>
          <T size={12} color={c.mute}>{[e.participant_name ?? e.team_name, e.receipt_no].filter(Boolean).join(' · ')}</T>
          {e.due_cents > 0 ? <T size={13} weight="800" color={c.sun}>{fmtMoney(e.due_cents, e.currency)} still to pay</T> : null}
        </Card>
      )) : <Empty emoji="📝" title="No registrations yet" sub="When you register yourself, a child or your team, it shows up here with its status." />) : null}
      {tab === 'run' && run.data ? (
        <>
          <Btn title="New registration programme" onPress={() => push('RegistrationSetup')} accessibilityLabel="Create a registration programme" />
          {run.data.length ? run.data.map((p) => (
            <Card key={p.id} onPress={() => push('RegistrationManage', { id: p.id })} accessibilityLabel={`Manage ${p.title}`}>
              <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><T size={22}>{kindOf(p.kind).emoji}</T><T weight="900" style={{ flex: 1 }} numberOfLines={2}>{p.title}</T><Tag label={p.status} color={p.status === 'open' ? c.limeSoft : c.violetSoft} /></View>
              <T size={12} color={c.mute}>{[kindOf(p.kind).label, places(p.availability), p.availability?.waitlisted ? `${p.availability.waitlisted} waiting` : null].filter(Boolean).join(' · ')}</T>
            </Card>
          )) : <Empty emoji="🏟️" title="You do not run any registrations yet" sub="Create a programme for a membership, course, team entry, competition or licence." />}
        </>
      ) : null}
    </Screen>
  );
}

const stepsOf = (def, hasWaivers, hasFees) => [{ id: 'who', title: 'Who is registering' }, ...def.sections.map((s) => ({ id: s.id, title: s.title })), ...(hasWaivers ? [{ id: 'waivers', title: 'Consents and waivers' }] : []), ...(hasFees ? [{ id: 'fees', title: 'Fees' }] : []), { id: 'review', title: 'Review and submit' }];

/** Register: choose who, answer the form, sign, see the fee, submit. Resumable (the draft is private and kept), and every rule is the server's. */
export function RegistrationApply({ id, entry_id }) {
  const { toast } = useSession();
  const { push } = useNav();
  const prog = useLoad(() => api.get(`/registration-programmes/${id}`), [id]);
  const people = useLoad(() => api.get('/me/registration-participants'), []);
  const p = prog.data;
  const needsTeam = p && ['team', 'competition'].includes(p.kind);
  const teams = useLoad(() => (needsTeam ? api.get('/teams', { mine: true, limit: 50 }) : Promise.resolve([])), [needsTeam]);
  const [step, setStep] = useState(0);
  const [who, setWho] = useState(null);
  const [teamId, setTeamId] = useState('');
  const [entry, setEntry] = useState(null);
  const [answers, setAnswers] = useState({});
  const [texts, setTexts] = useState({});
  const [codes, setCodes] = useState([]);
  const [codeText, setCodeText] = useState('');
  const [plan, setPlan] = useState('full');
  const [quote, setQuote] = useState(null);
  const [names, setNames] = useState({});
  const [issues, setIssues] = useState([]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const [pay, setPay] = useState(null);
  const key = useRef(newKey());

  const resending = !!entry && entry.status === 'info_requested'; // a sent-back registration keeps the form version it was filled under
  const def = resending ? entry.form : p?.version?.form;
  const waivers = (resending ? entry.waivers : p?.version?.waivers) ?? [];
  const fees = p?.version?.fees;
  const hasFees = !!fees && (fees.items?.length ?? 0) > 0;
  const steps = def ? stepsOf(def, waivers.length > 0, hasFees) : [];
  const cur = steps[step];
  const vis = def ? visibleKeys(def, answers) : new Set();

  // resume a draft of mine, or note a registration that is already live
  useEffect(() => {
    if (!p) return;
    if (entry_id) { api.get(`/registration-entries/${entry_id}`).then((e) => { take(e); setWho(e.participant_id ?? 'team'); setTeamId(e.team_id ?? ''); setStep(1); }).catch((x) => toast(explain(x))); return; }
    const live = p.my_entries.find((e) => e.status !== 'draft' && !['rejected', 'withdrawn', 'cancelled'].includes(e.status));
    const draft = p.my_entries.find((e) => e.status === 'draft');
    if (draft && !entry && !live) api.get(`/registration-entries/${draft.id}`).then((e) => { take(e); setWho(e.participant_id ?? 'team'); setTeamId(e.team_id ?? ''); setStep(1); }).catch(() => {});
  }, [p?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (people.data && !who && p && p.kind !== 'team') setWho(people.data[0]?.user_id ?? null); }, [people.data, p?.kind]); // eslint-disable-line react-hooks/exhaustive-deps

  const take = (e) => { setEntry(e); setAnswers(e.answers ?? {}); setCodes(e.discount_codes ?? []); if (e.quote?.plan_choice) setPlan(e.quote.plan_choice); };
  const refresh = async () => { if (entry) take(await api.get(`/registration-entries/${entry.id}`)); };
  const fail = (e) => {
    if (e.details?.issues?.length) { setIssues(e.details.issues); const s = stepOfIssue(def, e.details.issues[0].path); setStep(Math.min(steps.length - 1, s + 1)); toast('Some answers need attention'); }
    else toast(explain(e));
  };
  const save = async (cur0 = entry) => {
    const clean = {}; for (const f of fieldsOf(def)) if (vis.has(f.key) && !['file', 'budget', 'references'].includes(f.type) && filled(answers[f.key])) clean[f.key] = answers[f.key];
    const e = await api.patch(`/registration-entries/${cur0.id}`, { row_version: cur0.row_version, answers: clean, codes, plan });
    take(e); return e;
  };
  const start = async () => {
    setBusy(true);
    try {
      if (!entry) {
        const body = { answers: {}, codes: [], plan: 'full', ...(p.kind === 'team' ? { team_id: teamId } : { participant_id: who, ...(teamId ? { team_id: teamId } : {}) }) };
        take(await api.post(`/registration-programmes/${id}/entries`, body));
      }
      setStep(1);
    } catch (e) { toast(e.details?.code === 'duplicate_registration' ? 'There is already a registration for this person. Open it from My registrations.' : explain(e)); } finally { setBusy(false); }
  };
  const next = async () => {
    setBusy(true); setIssues([]);
    try {
      if (cur.id === 'who') return await start();
      let e = entry;
      if (def.sections.some((s) => s.id === cur.id) || cur.id === 'fees') e = await save();
      if (cur.id === 'fees' || steps[step + 1]?.id === 'fees') setQuote(await api.post(`/registration-programmes/${id}/quote`, { answers: e.answers, codes, plan }));
      setStep(step + 1);
    } catch (e) { fail(e); } finally { setBusy(false); }
  };
  useEffect(() => { if (cur?.id === 'fees' && entry) api.post(`/registration-programmes/${id}/quote`, { answers: entry.answers, codes, plan }).then(setQuote).catch(() => {}); }, [cur?.id, codes.join(','), plan]); // eslint-disable-line react-hooks/exhaustive-deps

  const sign = async (w) => {
    const typed = (names[w.key] ?? '').trim();
    if (typed.length < 2) return toast('Type your full name to sign');
    try { await api.post(`/registration-entries/${entry.id}/signatures`, { waiver_key: w.key, signature: typed, accept: true }); await refresh(); toast('Signed'); } catch (e) { toast(explain(e)); }
  };
  const submit = async () => {
    setBusy(true); setIssues([]);
    try {
      const e = await save();
      const res = await api.post(`/registration-entries/${e.id}/submit`, { row_version: e.row_version, idempotency_key: key.current });
      key.current = newKey(); setDone(res);
    } catch (e) {
      if (e.details?.code === 'stale_form_version') { toast('The organiser updated the form. Your answers were kept; please review.'); prog.reload(); await refresh().catch(() => {}); setStep(1); }
      else if (e.details?.code === 'waivers_unsigned') { toast(e.message); setStep(steps.findIndex((s) => s.id === 'waivers')); }
      else fail(e);
    } finally { setBusy(false); }
  };

  if (prog.error) return <Screen><LoadError error={prog.error} onRetry={prog.reload} /></Screen>;
  if (prog.loading && !p) return <Screen><Loading /></Screen>;
  const k = kindOf(p.kind);
  const live = entry_id ? null : p.my_entries.find((e) => !['draft', 'rejected', 'withdrawn', 'cancelled'].includes(e.status));
  if (done) {
    const due = done.instalments?.find((i) => i.status === 'unpaid');
    return (
      <Screen wide>
        <Card color={done.status === 'waitlisted' ? c.cyanSoft : c.limeSoft}>
          <T weight="900" size={20}>{done.status === 'waitlisted' ? 'You are on the waiting list' : done.status === 'approved' ? 'You are registered' : 'Registration received'}</T>
          <T weight="800">Receipt {done.receipt_no}</T>
          <T size={13}>{done.status === 'waitlisted' ? 'No payment is taken until a place opens up. We will tell you straight away.' : done.status === 'approved' ? 'Your place is confirmed.' : 'The organiser will review it and tell you the result.'}</T>
        </Card>
        {due ? <Btn title={`Pay ${fmtMoney(due.amount_cents, done.currency)}${done.instalments.length > 1 ? ` · instalment ${due.seq} of ${done.instalments.length}` : ''}`} onPress={() => setPay({ id: due.id, type: 'registration_instalment', label: p.title, amount: due.amount_cents, currency: done.currency })} /> : null}
        <Btn title="View my registration" color={c.paper} ink={c.ink} onPress={() => push('RegistrationEntry', { id: done.id })} />
        {pay ? <PaySheet target={pay} onClose={() => setPay(null)} onDone={() => { setPay(null); push('RegistrationEntry', { id: done.id }); }} /> : null}
      </Screen>
    );
  }
  if (live) return <Screen wide><H1>{p.title}</H1><Card><T weight="800">You already have a registration here</T><View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><StatusTag status={live.status} /><T size={12} color={c.mute}>{live.receipt_no}</T></View><Btn small title="Open it" style={{ alignSelf: 'flex-start' }} onPress={() => push('RegistrationEntry', { id: live.id })} /></Card></Screen>;
  if (!def) return <Screen wide><H1>{p.title}</H1><Empty emoji="🛠️" title="Not ready yet" sub="The organiser has not published the registration form." /></Screen>;
  if (!p.availability.accepting && !resending) return <Screen wide><H1>{p.title}</H1><Empty emoji="⏳" title={places(p.availability)} sub={p.closes_at ? `Registration closes ${day(p.closes_at)}` : undefined} /></Screen>;

  const form = { values: answers, setValue: (key2, v) => setAnswers((prev) => { const n = { ...prev }; if (v === undefined || v === '') delete n[key2]; else n[key2] = v; return n; }), currency: p.currency, texts, setText: (key2, t) => setTexts((x) => ({ ...x, [key2]: t })),
    files: entry?.files ?? [], applicationId: entry?.id, ensureDraft: async () => entry.id, reloadFiles: refresh, budget: [], setBudget: () => {}, refs: [], setRefs: () => {}, uploadBase: '/registration-entries', removeBase: '/registration-files', who: 'the organiser' };
  const badOf = (f) => issues.find((i) => i.path === `answers.${f.key}` || i.path === `files.${f.key}`)?.message;
  const person = people.data?.find((x) => x.user_id === who);
  const canStart = p.kind === 'team' ? !!teamId : !!who && (p.kind !== 'competition' || !!teamId) && (!person || person.consent_ok || person.relation === 'self' || !person.youth);

  return (
    <Screen wide>
      <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}><T size={28}>{k.emoji}</T><View style={{ flex: 1 }}><H1>{p.title}</H1><T size={12} color={c.mute} style={{ marginTop: 4 }}>{[k.label, p.organisation_name ?? p.event_name, places(p.availability)].filter(Boolean).join(' · ')}</T></View></View>
      <View accessibilityRole="progressbar" accessibilityLabel={`Step ${step + 1} of ${steps.length}`} style={{ flexDirection: 'row', gap: 6 }}>{steps.map((s, i) => <View key={s.id} style={{ flex: 1, height: 6, borderRadius: 3, backgroundColor: i <= step ? c.pink : c.line }} />)}</View>
      {issues.length ? <Card color={c.pinkSoft}><T weight="800">Please check</T>{issues.slice(0, 6).map((i, n) => <T key={n} size={13}>• {i.message}</T>)}</Card> : null}

      <Section title={cur.title} color={c.pink}>
        {cur.id === 'who' ? (
          <>
            {p.kind === 'team' ? (
              <MenuField label="Team" value={teamId} onChange={setTeamId} placeholder="Choose a team you manage" options={(teams.data ?? []).map((t) => ({ value: t.id, label: t.name, sub: t.sport }))} hint="Only teams you manage can be registered." />
            ) : (
              <>
                <MenuField label="Who is this for?" value={who} onChange={setWho} options={(people.data ?? []).map((x) => ({ value: x.user_id, label: x.relation === 'self' ? `${x.display_name} (me)` : x.display_name, sub: x.relation === 'dependent' ? (x.consent_ok ? 'Child · guardian consent given' : 'Child · guardian consent needed') : undefined }))} />
                {person && person.youth && person.relation === 'dependent' && !person.consent_ok ? <Card color={c.sunSoft}><T size={13}>A verified guardian must allow participation first (Family & guardians).</T><Btn small title="Open Family & guardians" color={c.paper} ink={c.ink} style={{ alignSelf: 'flex-start' }} onPress={() => push('Family')} /></Card> : null}
                {p.kind === 'competition' ? <MenuField label="Team" value={teamId} onChange={setTeamId} placeholder="Choose the team they play for" options={(teams.data ?? []).map((t) => ({ value: t.id, label: t.name, sub: t.sport }))} hint="The team must be entered in this competition." /> : null}
              </>
            )}
            <T size={12} color={c.mute}>Nothing is held and nothing is charged until you submit.</T>
          </>
        ) : null}
        {def?.sections.some((s) => s.id === cur.id) ? def.sections.find((s) => s.id === cur.id).fields.filter((f) => vis.has(f.key)).map((f) => <Question key={f.key} f={f} form={form} bad={badOf(f)} />) : null}
        {cur.id === 'waivers' ? (
          <>
            {waivers.map((w) => {
              const un = entry?.waivers_unsigned?.find((x) => x.key === w.key);
              const signed = entry?.signatures?.find((s) => s.waiver_key === w.key && s.waiver_sha256 === w.sha256);
              return (
                <Card key={w.key} color={signed ? c.limeSoft : c.paper}>
                  <T weight="900">{w.title}{w.required ? '' : ' (optional)'}</T>
                  <T size={13}>{w.body}</T>
                  {signed ? <T size={12} weight="800" color={c.lime}>✓ Signed by {signed.signer_name} · {stamp(signed.signed_at)}</T> : (
                    <>
                      {un?.signer === 'guardian' && person?.relation !== 'dependent' && person?.youth ? <T size={12} color={c.red}>A verified guardian must sign this for a young person.</T> : null}
                      <Field label="Type your full name to sign" value={names[w.key] ?? ''} onChangeText={(x) => setNames((n) => ({ ...n, [w.key]: x }))} maxLength={160} accessibilityLabel={`Sign ${w.title}`} />
                      <Btn small title="I agree and sign" style={{ alignSelf: 'flex-start' }} onPress={() => sign(w)} />
                    </>
                  )}
                </Card>
              );
            })}
          </>
        ) : null}
        {cur.id === 'fees' ? (
          <>
            {quote ? (
              <Card>
                {quote.lines.map((l) => <View key={l.key} style={{ flexDirection: 'row' }}><T style={{ flex: 1 }}>{l.label}</T><T weight="700">{fmtMoney(l.amount_cents, p.currency)}</T></View>)}
                {quote.discounts.map((d) => <View key={d.key} style={{ flexDirection: 'row' }}><T style={{ flex: 1 }} color={c.lime}>{d.label}{d.code ? ` (${d.code})` : ''}</T><T weight="700" color={c.lime}>−{fmtMoney(d.amount_cents, p.currency)}</T></View>)}
                <View style={{ flexDirection: 'row', borderTopWidth: 1, borderColor: c.line, paddingTop: 8, marginTop: 4 }}><T weight="900" style={{ flex: 1 }}>Total</T><T weight="900">{fmtMoney(quote.total_cents, p.currency)}</T></View>
                {quote.rejected_codes.length ? <T size={12} color={c.red}>Code {quote.rejected_codes.join(', ')} is not valid.</T> : null}
              </Card>
            ) : <Loading />}
            {(fees.discounts ?? []).some((d) => d.code) || codes.length ? (
              <View style={{ gap: 8 }}>
                <Field label="Discount code" value={codeText} onChangeText={(x) => setCodeText(x.toUpperCase())} maxLength={24} placeholder="Have a code?" accessibilityLabel="Discount code" />
                <Btn small title="Apply code" color={c.violet} style={{ alignSelf: 'flex-start' }} disabled={codeText.trim().length < 3} onPress={() => { setCodes([...new Set([...codes, codeText.trim()])]); setCodeText(''); }} />
                {codes.length ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{codes.map((x) => <Chip key={x} active label={`${x}  ✕`} onPress={() => setCodes(codes.filter((y) => y !== x))} />)}</View> : null}
              </View>
            ) : null}
            {quote?.instalments_offered ? (
              <View style={{ gap: 6 }}>
                <T weight="800" size={13}>How would you like to pay?</T>
                <Seg options={[{ value: 'full', label: 'All now' }, { value: 'instalments', label: `${fees.instalments.count} instalments` }]} value={plan} onChange={setPlan} />
                {plan === 'instalments' ? quote.instalments.map((i) => <T key={i.seq} size={13}>{i.seq}. {fmtMoney(i.amount_cents, p.currency)} · {day(i.due_on)}</T>) : null}
              </View>
            ) : null}
            <T size={12} color={c.mute}>You pay securely through Gotmygame after you submit. Card details never touch us.</T>
          </>
        ) : null}
        {cur.id === 'review' ? (
          <>
            {def.sections.map((s, i) => (
              <Card key={s.id}>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}><T weight="900" style={{ flex: 1 }}>{s.title}</T><Btn small title="Edit" color={c.paper} ink={c.ink} onPress={() => setStep(i + 1)} /></View>
                {s.fields.filter((f) => vis.has(f.key)).map((f) => {
                  const ok = f.type === 'file' ? form.files.some((x) => x.field_key === f.key) : filled(answers[f.key]);
                  return <T key={f.key} size={13} color={ok ? c.ink : f.required ? c.red : c.mute}>{ok ? '✓' : f.required ? '✗ Missing:' : '–'} {f.label}</T>;
                })}
              </Card>
            ))}
            {waivers.length ? <Card><T weight="900">Consents</T>{waivers.map((w) => <T key={w.key} size={13} color={entry?.waivers_unsigned?.some((x) => x.key === w.key) ? c.red : c.ink}>{entry?.waivers_unsigned?.some((x) => x.key === w.key) ? '✗ Not signed:' : '✓'} {w.title}</T>)}</Card> : null}
            {quote ? <T weight="800">Total {fmtMoney(quote.total_cents, p.currency)}</T> : null}
            <T size={12} color={c.mute}>When you submit you get a receipt. Submitting twice (a retry or a double tap) never files it twice. {p.availability.full && p.availability.waitlist_open ? 'The programme is full: you will join the waiting list and nothing is charged.' : ''}</T>
            <Btn title="Submit registration" loading={busy} onPress={submit} />
          </>
        ) : null}
      </Section>
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
        {step > 0 ? <Btn title="Back" color={c.paper} ink={c.ink} onPress={() => setStep(step - 1)} style={{ flex: 1 }} /> : null}
        {cur.id !== 'review' ? <Btn title={cur.id === 'who' ? 'Start' : 'Next'} loading={busy} disabled={cur.id === 'who' && !canStart} onPress={next} style={{ flex: 2 }} /> : null}
      </View>
      {pay ? <PaySheet target={pay} onClose={() => setPay(null)} onDone={() => setPay(null)} /> : null}
    </Screen>
  );
}

/** One registration: its status and history, what was answered and signed, the fee and instalments (pay here), change requests, withdrawal and (for staff) the decision. */
export function RegistrationEntry({ id }) {
  const { toast } = useSession();
  const { push } = useNav();
  const load = useLoad(() => api.get(`/registration-entries/${id}`), [id]);
  const e = load.data;
  const [pay, setPay] = useState(null);
  const [sheet, setSheet] = useState(null); // { action } for staff, 'change' for the applicant
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [chg, setChg] = useState({});
  const [busy, setBusy] = useState(false);
  const ver = useLoad(() => (e ? api.get(`/registration-programmes/${e.programme.id}`) : Promise.resolve(null)), [e?.programme?.id]);
  if (load.error) return <Screen><LoadError error={load.error} onRetry={load.reload} /></Screen>;
  if (load.loading && !e) return <Screen><Loading /></Screen>;
  const act = async (fn, msg) => { setBusy(true); try { await fn(); if (msg) toast(msg); setSheet(null); setNote(''); setReason(''); await load.reload(); } catch (x) { toast(explain(x)); if (x.status === 409) load.reload(); } finally { setBusy(false); } };
  const decide = (action) => act(() => api.post(`/registration-entries/${e.id}/decision`, { action, row_version: e.row_version, ...(note.trim() ? { note: note.trim() } : {}) }), 'Done');
  const unpaid = e.instalments.filter((i) => i.status === 'unpaid');
  const k = kindOf(e.programme.kind);
  const fields = ver.data?.version ? fieldsOf(ver.data.version.form) : [];
  const show = (f, v) => (Array.isArray(v) ? v.map((x) => f.options?.find((o) => o.value === x)?.label ?? x).join(', ') : f.type === 'yesno' ? (v ? 'Yes' : 'No') : f.type === 'choice' ? (f.options?.find((o) => o.value === v)?.label ?? v) : String(v));
  const openFile = async (x) => { try { const blob = await api.download(`/registration-files/${x.id}`); if (Platform.OS === 'web') { const u = URL.createObjectURL(blob); window.open(u, '_blank', 'noopener'); setTimeout(() => URL.revokeObjectURL(u), 120000); } else toast('Open this file on the web app'); } catch (x2) { toast(explain(x2)); } };
  const needsNote = ['reject', 'request_info'].includes(sheet?.action);
  return (
    <Screen onRefresh={load.reload} refreshing={load.loading && !!e} wide>
      <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}><T size={28}>{k.emoji}</T><View style={{ flex: 1 }}><H1>{e.programme.title}</H1><T size={12} color={c.mute} style={{ marginTop: 4 }}>{[k.label, e.participant_name ?? e.team_name].filter(Boolean).join(' · ')}</T>{e.receipt_no ? <T size={12} weight="800" color={c.mute}>Receipt {e.receipt_no}</T> : null}</View><StatusTag status={e.status} /></View>
      <ManagedBanner managed={e.managed_in} />
      {e.status === 'info_requested' ? <Card color={c.pinkSoft}><T weight="900">The organiser needs more information</T><T>{[...e.history].reverse().find((h) => h.action === 'info_requested')?.note}</T><Btn small title="Edit and resend" style={{ alignSelf: 'flex-start' }} onPress={() => push('RegistrationApply', { id: e.programme.id, entry_id: e.id })} /></Card> : null}
      {e.status === 'waitlisted' ? <Card color={c.cyanSoft}><T weight="800">You are on the waiting list</T><T size={13}>No payment is taken until a place opens up.</T></Card> : null}
      {e.status === 'rejected' ? <Card color={c.pinkSoft}><T weight="900">Declined</T><T>{[...e.history].reverse().find((h) => h.action === 'rejected')?.note}</T></Card> : null}

      {e.instalments.length ? (
        <Section title="Fees" color={c.sun}>
          {e.instalments.map((i) => (
            <View key={i.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <T style={{ flex: 1 }}>{e.instalments.length > 1 ? `Instalment ${i.seq} · ` : ''}due {day(i.due_on)}</T><T weight="800">{fmtMoney(i.amount_cents, i.currency)}</T>
              {i.status === 'unpaid' && e.can.pay ? <Btn small title="Pay" onPress={() => setPay({ id: i.id, type: 'registration_instalment', label: e.programme.title, amount: i.amount_cents, currency: i.currency })} accessibilityLabel={`Pay instalment ${i.seq}`} /> : <Tag label={i.status === 'paid' ? 'Paid' : i.status} color={i.status === 'paid' ? c.limeSoft : c.violetSoft} />}
            </View>
          ))}
          <T size={12} color={c.mute}>Total {fmtMoney(e.total_cents, e.currency)}{e.discount_cents ? ` after ${fmtMoney(e.discount_cents, e.currency)} discount` : ''} · paid {fmtMoney(e.paid_cents, e.currency)}</T>
        </Section>
      ) : null}

      {e.eligibility ? (
        <Section title="Eligibility" color={c.cyan}>
          <Tag label={e.eligibility.decision} color={e.eligibility.decision === 'eligible' ? c.limeSoft : e.eligibility.decision === 'ineligible' ? c.pinkSoft : c.sunSoft} />
          {e.eligibility.checks.map((x, i) => <T key={i} size={13} color={x.status === 'pass' ? c.ink : x.status === 'fail' ? c.red : c.mute}>{x.status === 'pass' ? '✓' : x.status === 'fail' ? '✗' : '•'} {x.reason}</T>)}
        </Section>
      ) : null}

      <Section title="Answers" color={c.cyan}>
        {fields.filter((f) => f.type !== 'file' && filled(e.answers[f.key])).map((f) => <View key={f.key}><T size={12} color={c.mute}>{f.label}</T><T>{show(f, e.answers[f.key])}</T></View>)}
        {e.files.map((x) => <Btn key={x.id} small title={`📎 ${x.original_name ?? 'File'}`} color={c.paper} ink={c.ink} style={{ alignSelf: 'flex-start' }} onPress={() => openFile(x)} />)}
        {!fields.length ? <T size={13} color={c.mute}>No answers on file.</T> : null}
      </Section>

      {e.waivers.length ? <Section title="Signed" color={c.mint}>{e.waivers.map((w) => { const s = e.signatures.find((x) => x.waiver_key === w.key && x.waiver_sha256 === w.sha256); return <T key={w.key} size={13} color={s ? c.ink : c.mute}>{s ? `✓ ${w.title} · ${s.signer_name}, ${s.signer_role} · ${stamp(s.signed_at)}` : `– ${w.title}: not signed`}</T>; })}</Section> : null}

      {e.changes.length ? <Section title="Change requests" color={c.sun}>{e.changes.map((x) => <View key={x.id}><T size={13}><T weight="800" size={13}>{x.status}</T> · {x.reason}</T>{x.decision_note ? <T size={12} color={c.mute}>{x.decision_note}</T> : null}{x.status === 'pending' && e.can.decide ? <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}><Btn small title="Approve" onPress={() => act(() => api.post(`/registration-changes/${x.id}/decision`, { approve: true }), 'Change applied')} /><Btn small title="Decline" color={c.paper} ink={c.red} onPress={() => setSheet({ action: 'decline_change', id: x.id })} /></View> : null}</View>)}</Section> : null}

      <Section title="History" color={c.violet}>{e.history.map((h) => <T key={h.id} size={13}>{stamp(h.created_at)} · {h.action.replace('_', ' ')}{h.actor_name ? ` · ${h.actor_name}` : ''}{h.note ? ` — ${h.note}` : ''}</T>)}</Section>

      <View style={{ gap: 8, marginTop: 12 }}>
        {e.can.decide ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {e.status === 'submitted' ? <Btn small title="Start review" color={c.violet} onPress={() => decide('review')} /> : null}
            {['submitted', 'under_review'].includes(e.status) ? <Btn small title="Approve" onPress={() => decide('approve')} loading={busy} /> : null}
            {['submitted', 'under_review'].includes(e.status) ? <Btn small title="Ask for information" color={c.paper} ink={c.ink} onPress={() => setSheet({ action: 'request_info' })} /> : null}
            {['submitted', 'under_review'].includes(e.status) ? <Btn small title="Move to waiting list" color={c.paper} ink={c.ink} onPress={() => decide('waitlist')} /> : null}
            {e.status === 'waitlisted' ? <Btn small title="Offer a place" onPress={() => decide('promote')} /> : null}
            {['submitted', 'under_review', 'info_requested', 'waitlisted', 'approved'].includes(e.status) ? <Btn small title="Decline" color={c.paper} ink={c.red} onPress={() => setSheet({ action: 'reject' })} /> : null}
          </View>
        ) : null}
        {e.can.request_change ? <Btn small title="Ask for a change" color={c.paper} ink={c.ink} style={{ alignSelf: 'flex-start' }} onPress={() => { setChg({ ...e.answers }); setSheet({ action: 'change' }); }} /> : null}
        {e.can.withdraw ? <Btn small title="Withdraw registration" color={c.paper} ink={c.red} style={{ alignSelf: 'flex-start' }} onPress={() => setSheet({ action: 'withdraw' })} /> : null}
      </View>

      <Sheet visible={!!sheet && sheet.action !== 'change'} onClose={() => setSheet(null)} title={{ reject: 'Decline this registration', request_info: 'What do you need?', withdraw: 'Withdraw this registration?', decline_change: 'Decline the change' }[sheet?.action] ?? ''}>
        <Field label={sheet?.action === 'withdraw' ? 'Reason (optional)' : 'Message to the applicant'} value={sheet?.action === 'withdraw' ? reason : note} onChangeText={sheet?.action === 'withdraw' ? setReason : setNote} multiline maxLength={500} />
        {sheet?.action === 'withdraw' ? <T size={12} color={c.mute}>Unpaid instalments are cancelled and your place goes to the waiting list. Money already paid is returned by the organiser.</T> : null}
        <Btn title="Confirm" loading={busy} disabled={(needsNote || sheet?.action === 'decline_change') && note.trim().length < 3}
          onPress={() => (sheet.action === 'withdraw' ? act(() => api.post(`/registration-entries/${e.id}/withdraw`, { row_version: e.row_version, ...(reason.trim() ? { reason: reason.trim() } : {}) }), 'Withdrawn')
            : sheet.action === 'decline_change' ? act(() => api.post(`/registration-changes/${sheet.id}/decision`, { approve: false, note: note.trim() }), 'Declined') : decide(sheet.action))} />
      </Sheet>
      <Sheet visible={sheet?.action === 'change'} onClose={() => setSheet(null)} title="Ask for a change">
        <T size={13} color={c.mute}>Change what is wrong; the organiser decides. Nothing changes until they approve.</T>
        {fields.filter((f) => !['file', 'budget', 'references'].includes(f.type) && visibleKeys(ver.data.version.form, chg).has(f.key)).map((f) => <Question key={f.key} f={f} form={{ values: chg, setValue: (k2, v) => setChg((p) => { const n = { ...p }; if (v === undefined || v === '') delete n[k2]; else n[k2] = v; return n; }), currency: e.currency, texts: {}, setText: () => {}, files: [], budget: [], refs: [] }} />)}
        <Field label="Why?" value={reason} onChangeText={setReason} maxLength={500} />
        <Btn title="Send request" loading={busy} disabled={reason.trim().length < 3} onPress={() => act(() => api.post(`/registration-entries/${e.id}/changes`, { answers: chg, reason: reason.trim() }), 'Request sent')} />
      </Sheet>
      {pay ? <PaySheet target={pay} onClose={() => setPay(null)} onDone={() => { setPay(null); load.reload(); }} /> : null}
    </Screen>
  );
}
