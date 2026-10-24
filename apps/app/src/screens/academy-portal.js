// The family / athlete side of the academy: what needs your attention, where each application stands, your programmes, what is due,
// and a programme browser with a step-by-step application (details, questions, agreements, exact price, confirm).
// Identity, guardian authority and payments are the canonical records; nothing here is a copy.
import React, { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Chip, Empty, ErrorBox, Field, H1, Loading, Row, Screen, Seg, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { Stepper } from '../pickers';
import { PaySheet } from '../PaySheet';
import { c } from '../theme';
import { moneyIn } from '../vtime';
import { explain } from '../access';
import { useLayout } from '../layout';
import { FamilyProgress } from './academy-progress';
import { MySessions } from './academy-session';
import { Block, TrialSlots, FORMATS, FOCUS, Initials, Meter, StageBadge, StageTrack, Timeline, STAGE, hoursLeft, lab, openEnrolmentLetter, openInvoicePdf, priceLine, when } from './academy-ui';

const Panel = ({ children, tone }) => <View style={{ backgroundColor: tone ?? c.paper, borderRadius: 20, padding: 16, gap: 10, borderWidth: 1, borderColor: c.line }}>{children}</View>;
const OPEN = ['enquiry', 'trial_requested', 'trial_booked', 'trial_completed', 'application_draft', 'submitted', 'under_review', 'offered', 'offer_accepted', 'waitlisted'];

export function AcademyFamily() {
  const { toast } = useSession();
  const fam = useLoad(() => api.get('/me/academy'), []);
  const [pick, setWho] = useState(null), [tab, setTab] = useState('overview'), [pay, setPay] = useState(null), [apply, setApply] = useState(null), [form, setForm] = useState(null), [slots, setSlots] = useState(null);
  const { tablet } = useLayout();
  if (fam.error) return <Screen><ErrorBox error={fam.error} onRetry={fam.reload} /></Screen>;
  if (!fam.data) return <Screen><Loading /></Screen>;
  const people = fam.data.people;
  const score = (x) => x.enrolments.length * 3 + x.applications.length + x.charges.length + x.to_do.length;
  const busiest = people.reduce((best, x, i) => (score(x) > score(people[best]) ? i : best), 0);
  const who = Math.min(pick ?? busiest, people.length - 1);   // open on the person with something going on, not on an empty profile
  const p = people[who];
  const apps = p.applications, live = apps.filter((a) => OPEN.includes(a.stage));
  const due = p.charges.filter((x) => x.status === 'awaiting_payment');
  const overdue = due.filter((x) => x.overdue);
  const respond = async (a, accept) => { try { await api.post(`/academy/applications/${a.id}/offer`, { row_version: a.row_version, accept }); toast(accept ? 'You are in — welcome!' : 'Offer declined'); } catch (e) { toast(explain(e)); } finally { fam.reload(); } };
  const act = async (fn, msg) => { try { await fn(); toast(msg); } catch (e) { toast(explain(e)); } finally { fam.reload(); } };
  const attention = [
    ...apps.filter((a) => a.stage === 'offered').map((a) => ({ key: `o${a.id}`, tone: c.sunSoft, icon: '🎟️', title: `A place is offered: ${a.programme}`, sub: `${a.organisation} · ${a.offer_expires_at ? hoursLeft(a.offer_expires_at) : ''}`, actions: <View style={{ flexDirection: 'row', gap: 8 }}><Btn small title="Accept" onPress={() => respond(a, true)} /><Btn small title="Decline" color={c.paper} ink={c.ink} onPress={() => respond(a, false)} /></View> })),
    ...p.to_do.map((t) => ({ key: `t${t.application_id}`, tone: c.sunSoft, icon: '📜', title: `Agree to ${t.agreements.map((a) => a.title).join(', ')}`, sub: t.programme, actions: <Btn small title="Read & agree" onPress={() => setApply({ continue: t.application_id })} /> })),
    ...apps.filter((a) => a.stage === 'application_draft').map((a) => ({ key: `d${a.id}`, tone: c.paper, icon: '📝', title: `Finish your application: ${a.programme}`, sub: a.organisation, actions: <Btn small title="Continue" onPress={() => setApply({ continue: a.id })} /> })),
    ...overdue.map((x) => ({ key: `p${x.id}`, tone: c.orangeSoft, icon: '💷', title: `Overdue: ${moneyIn(x.amount_minor, x.currency)}`, sub: `${x.kind} · was due ${when(x.due_on)}`, actions: <Btn small title="Pay now" onPress={() => setPay({ id: x.id, type: 'academy_charge', label: `Academy ${x.kind}`, amount: x.amount_minor, currency: x.currency })} /> })),
  ];
  return (
    <Screen wide>
      <H1>My academy</H1>
      <T color={c.mute} style={{ marginTop: 2 }}>Applications, programmes and payments for you{people.length > 1 ? ' and your children' : ''}, in one place.</T>
      {people.length > 1 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingVertical: 10 }}>
          {people.map((x, i) => (
            <Pressable key={x.athlete.id} onPress={() => setWho(i)} accessibilityRole="button" accessibilityState={{ selected: i === who }} accessibilityLabel={x.athlete.is_me ? 'Me' : x.athlete.display_name}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, paddingHorizontal: 14, borderRadius: 24, backgroundColor: i === who ? c.ink : c.paper, borderWidth: 1, borderColor: c.line, minHeight: 48 }}>
              <Initials user={x.athlete} size={28} /><T weight="700" color={i === who ? c.bg : c.ink}>{x.athlete.is_me ? 'Me' : x.athlete.display_name}</T>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
      <View style={{ marginTop: 6 }}><Seg value={tab} onChange={setTab} color={c.violet} options={[{ value: 'overview', label: 'Overview' }, { value: 'sessions', label: 'Sessions' }, { value: 'browse', label: 'Find a programme' }, { value: 'progress', label: 'Progress' }, { value: 'payments', label: `Payments${due.length ? ` (${due.length})` : ''}` }]} /></View>
      {tab === 'sessions' ? <View style={{ marginTop: 10 }}><MySessions key={p.athlete.id} athleteId={p.athlete.is_me ? undefined : p.athlete.id} toast={toast} /></View> : null}
      {tab === 'overview' ? (
        <View style={{ gap: 14, marginTop: 12 }}>
          {attention.length ? (
            <Panel><Block title="Needs your attention">{attention.map((it) => (
              <View key={it.key} style={{ padding: 12, borderRadius: 16, backgroundColor: it.tone, gap: 8 }}>
                <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}><T size={22}>{it.icon}</T><View style={{ flex: 1, gap: 2 }}><T weight="800" size={14}>{it.title}</T><T size={12} color={c.mute}>{it.sub}</T></View></View>
                <View style={{ flexDirection: 'row' }}>{it.actions}</View>
              </View>
            ))}</Block></Panel>
          ) : null}
          <View style={{ flexDirection: tablet ? 'row' : 'column', gap: 14, alignItems: 'flex-start' }}>
            <View style={{ flex: tablet ? 1 : undefined, width: tablet ? undefined : '100%', gap: 14 }}>
              <Panel>
                <Block title={`Programmes${p.enrolments.length ? ` (${p.enrolments.filter((e) => e.status === 'enrolled').length})` : ''}`}>
                  {p.enrolments.length ? p.enrolments.map((e) => (
                    <View key={e.id} style={{ padding: 12, borderRadius: 16, backgroundColor: c.bg, gap: 4 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><T weight="800" size={15} style={{ flex: 1 }}>{e.programme}</T><Tag label={e.status === 'enrolled' ? '🏅 Enrolled' : e.status} color={e.status === 'enrolled' ? c.lime : undefined} /></View>
                      <T size={12} color={c.mute}>{e.organisation} · {e.cohort}{e.starts_on ? ` · ${when(e.starts_on)}${e.ends_on ? ` – ${when(e.ends_on)}` : ''}` : ''}</T>
                      {e.sessions_left != null ? <T size={12} weight="700">{e.sessions_left} sessions left in your pack</T> : null}
                      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
                        {['enrolled', 'paused', 'completed', 'graduated'].includes(e.status) ? <Btn small title="Enrolment letter" onPress={() => openEnrolmentLetter(e.id, toast)} /> : null}
                        {e.status === 'enrolled' ? <Btn small title="Withdraw…" color={c.paper} ink={c.ink} onPress={() => setForm({ withdraw: e })} /> : null}
                      </View>
                    </View>
                  )) : <Empty emoji="🏅" title="Not in a programme yet" sub={p.athlete.is_me ? 'Find a programme to get started.' : `Find a programme for ${p.athlete.display_name}.`} />}
                  <Btn small title="Find a programme" color={c.paper} ink={c.ink} onPress={() => setTab('browse')} style={{ alignSelf: 'flex-start' }} />
                </Block>
              </Panel>
              {p.certificates?.length ? (
                <Panel>
                  <Block title="Certificates">
                    {p.certificates.map((x) => (
                      <Row key={x.id} title={x.title} sub={`${x.institution} · ${x.kind} · code ${x.code} · ${x.show_on_profile ? 'shown on the profile' : 'kept private'}`} right={<Btn small title={x.show_on_profile ? 'Hide' : 'Show'} color={c.paper} ink={c.ink} onPress={() => act(() => api.patch(`/me/credentials/${x.id}`, { show_on_profile: !x.show_on_profile }), x.show_on_profile ? 'Hidden from the profile' : 'Shown on the profile')} />} />
                    ))}
                    <T size={11} color={c.mute}>Anyone can check a certificate with its code.{!p.athlete.is_me ? ' You decide for your child.' : ''}</T>
                  </Block>
                </Panel>
              ) : null}
            </View>
            <View style={{ flex: tablet ? 1 : undefined, width: tablet ? undefined : '100%', gap: 14 }}>
              <Panel>
                <Block title="Applications">
                  {live.length ? live.map((a) => (
                    <View key={a.id} style={{ padding: 12, borderRadius: 16, backgroundColor: c.bg, gap: 8 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><View style={{ flex: 1 }}><T weight="800" size={14}>{a.programme}</T><T size={12} color={c.mute}>{a.organisation}</T></View><StageBadge stage={a.stage} /></View>
                      <StageTrack stage={a.stage} />
                      {a.trial?.session ? <T size={13} weight="700">🎽 Trial: {when(a.trial.session.local_date)} · {a.trial.session.local_start}–{a.trial.session.local_end}</T> : a.stage === 'trial_requested' ? <T size={13} color={c.mute}>Trial requested. Pick a time that suits you.</T> : null}
                      {a.waitlist_position ? <T size={13} weight="700">You are number {a.waitlist_position} on the waitlist. We will offer a place when one opens; we cannot promise a date.</T> : null}
                      {a.stage === 'offered' && a.offer_expires_at ? <T size={13} weight="700">Offer ends {when(a.offer_expires_at)} ({hoursLeft(a.offer_expires_at)})</T> : null}
                      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                        {a.stage === 'trial_requested' ? <Btn small title="Choose a trial time" onPress={() => setSlots({ ...a, athlete_id: p.athlete.id })} /> : null}
                        {a.stage === 'trial_booked' ? <Btn small title="Change time" color={c.paper} ink={c.ink} onPress={() => setSlots({ ...a, athlete_id: p.athlete.id })} /> : null}
                        {a.stage === 'trial_booked' ? <Btn small title="Cancel trial" color={c.paper} ink={c.ink} onPress={() => act(() => api.post(`/academy/applications/${a.id}/trial/cancel`, { row_version: a.row_version }), 'Trial cancelled')} /> : null}
                        {a.stage === 'enquiry' && a.programme_info?.trial_enabled ? <Btn small title="Ask for a trial" color={c.paper} ink={c.ink} onPress={() => act(() => api.post(`/academy/applications/${a.id}/trial`, { row_version: a.row_version }), 'Trial requested')} /> : null}
                        {['enquiry', 'trial_completed', 'application_draft'].includes(a.stage) ? <Btn small title="Continue application" onPress={() => setApply({ continue: a.id })} /> : null}
                        {a.stage !== 'offer_accepted' ? <Btn small title="Withdraw" color={c.paper} ink={c.ink} onPress={() => setForm({ cancel: a })} /> : null}
                      </View>
                      {a.history.length > 1 ? <Timeline items={a.history.slice(-3).map((h) => ({ title: STAGE[h.to_stage], sub: `${when(h.created_at)}${h.reason ? ` · ${h.reason}` : ''}` }))} /> : null}
                    </View>
                  )) : <T size={13} color={c.mute}>No open applications.</T>}
                </Block>
              </Panel>
            </View>
          </View>
        </View>
      ) : null}
      <TrialSlots app={slots} onClose={() => setSlots(null)} onBooked={fam.reload} toast={toast} />
      {tab === 'progress' ? <FamilyProgress key={p.athlete.id} athlete={p.athlete} toast={toast} /> : null}
      {tab === 'browse' ? <Browse people={people} who={who} onApply={(prog, athlete) => setApply({ prog, athlete })} /> : null}
      {tab === 'payments' ? (
        <View style={{ gap: 14, marginTop: 12 }}>
          <Panel>
            <Block title="To pay">
              {due.length ? due.map((x) => <Row key={x.id} title={`${moneyIn(x.amount_minor, x.currency)} · ${x.kind}`} sub={`due ${when(x.due_on)}${x.invoice_number ? ` · ${x.invoice_number}` : ''}${x.funded_minor > 0 ? ` · ${moneyIn(x.funded_minor, x.currency)} covered by ${x.funding_source}` : ''}${x.discount_minor > 0 ? ` · ${moneyIn(x.discount_minor, x.currency)} discount applied` : ''}`} color={x.overdue ? c.orangeSoft : c.paper}
                right={<View style={{ gap: 6, alignItems: 'flex-end' }}><Btn small title="Pay" onPress={() => setPay({ id: x.id, type: 'academy_charge', label: `Academy ${x.kind}`, amount: x.amount_minor, currency: x.currency })} />{x.invoice_id ? <Btn small title="Invoice" color={c.paper} ink={c.ink} onPress={() => openInvoicePdf(x.invoice_id, toast)} /> : null}</View>} />) : <Empty emoji="✅" title="Nothing to pay" sub="You are all up to date." />}
              <T size={11} color={c.mute}>Nothing is charged automatically. Each payment is made on the payment provider’s secure page.</T>
            </Block>
          </Panel>
          <Panel>
            <Block title="Paid">{p.charges.filter((x) => x.status === 'paid').length ? p.charges.filter((x) => x.status === 'paid').map((x) => <Row key={x.id} title={`${moneyIn(x.amount_minor, x.currency)} · ${x.kind}`} sub={`paid ${when(x.paid_at)}${x.invoice_number ? ` · ${x.invoice_number}` : ''}`} right={x.invoice_id ? <Btn small title="Receipt" color={c.paper} ink={c.ink} onPress={() => openInvoicePdf(x.invoice_id, toast)} /> : <Tag label="Paid" color={c.lime} />} />) : <T size={13} color={c.mute}>No payments yet.</T>}</Block>
          </Panel>
        </View>
      ) : null}
      {apply ? <Apply people={people} initial={apply} onClose={() => { setApply(null); fam.reload(); }} /> : null}
      {pay ? <PaySheet target={pay} onClose={() => setPay(null)} onDone={fam.reload} /> : null}
      <FormSheet visible={!!form?.withdraw} onClose={() => setForm(null)} title={`Withdraw from ${form?.withdraw?.programme ?? ''}`} submitLabel="Withdraw"
        fields={[{ key: 'reason', label: 'Why are you leaving? (optional)', type: 'multiline', optional: true }]} onSubmit={async (v) => { await api.post(`/academy-enrolments/${form.withdraw.id}/withdraw`, v); fam.reload(); return 'Withdrawn. Unpaid fees are cancelled; ask the academy about refunds for paid fees.'; }} />
      <FormSheet visible={!!form?.cancel} onClose={() => setForm(null)} title={`Withdraw application: ${form?.cancel?.programme ?? ''}`} submitLabel="Withdraw"
        fields={[{ key: 'reason', label: 'Reason (optional)', type: 'multiline', optional: true }]} onSubmit={async (v) => { await api.post(`/academy/applications/${form.cancel.id}/withdraw`, { row_version: form.cancel.row_version, ...v }); fam.reload(); return 'Application withdrawn'; }} />
    </Screen>
  );
}

function Browse({ people, who, onApply }) {
  const [sport, setSport] = useState(''), [focus, setFocus] = useState(null);
  const list = useLoad(() => api.get('/academy/programmes', { sport: sport || undefined, focus: focus || undefined, limit: 50 }), [sport, focus]);
  const { tablet } = useLayout();
  return (
    <View style={{ gap: 12, marginTop: 12 }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
        <Chip label="All sports" active={!sport} onPress={() => setSport('')} />
        {['football', 'cricket', 'tennis', 'basketball', 'swimming', 'badminton', 'athletics'].map((s) => <Chip key={s} label={s[0].toUpperCase() + s.slice(1)} active={sport === s} onPress={() => setSport(s)} />)}
        <Chip label="Any level" active={!focus} onPress={() => setFocus(null)} />
        {FOCUS.map(([k, l]) => <Chip key={k} label={l} active={focus === k} onPress={() => setFocus(k)} />)}
      </ScrollView>
      {list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !list.data ? <Loading /> : list.data.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
          {list.data.map((x) => {
            const full = x.capacity && x.seats_taken >= x.capacity;
            return (
              <Pressable key={x.id} onPress={() => onApply(x, people[who].athlete.id)} accessibilityRole="button" accessibilityLabel={`${x.title}, ${x.organisation_name}, ${priceLine(x)}, ${full ? 'full, waitlist open' : 'places available'}`}
                style={{ width: tablet ? '48.5%' : '100%', backgroundColor: c.paper, borderRadius: 20, padding: 16, gap: 8, borderWidth: 1, borderColor: c.line }}>
                <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><T weight="800" size={16} style={{ flex: 1 }}>{x.title}</T><Tag label={full ? 'Waitlist' : 'Places left'} color={full ? c.orangeSoft : c.lime} /></View>
                <T size={13} color={c.mute}>{x.organisation_name}{x.city ? ` · ${x.city}` : ''}</T>
                <T size={13} color={c.mute}>{lab(FORMATS, x.format)} · {x.sport}{x.age_min != null ? ` · ages ${x.age_min}–${x.age_max ?? '+'}` : ''} · {lab(FOCUS, x.focus)}</T>
                {x.starts_on ? <T size={13} color={c.mute}>📅 {when(x.starts_on)}{x.ends_on ? ` – ${when(x.ends_on)}` : ''}</T> : null}
                <Meter filled={x.seats_taken} capacity={x.capacity} waitlisted={x.waitlisted} compact />
                <View style={{ flexDirection: 'row', alignItems: 'center' }}><T weight="800" size={17} style={{ flex: 1 }}>{priceLine({ ...x, billing_model: x.billing_model })}</T><Btn small title={full ? 'Join waitlist' : 'View & apply'} onPress={() => onApply(x, people[who].athlete.id)} /></View>
              </Pressable>
            );
          })}
        </View>
      ) : <Empty emoji="🔎" title="No programmes match" sub="Try another sport or level. Academies appear here once they publish a public programme." />}
    </View>
  );
}

const WIZ = ['Programme', 'Questions', 'Agreements', 'Price', 'Confirm'];
function Apply({ people, initial, onClose }) {
  const { toast } = useSession();
  const [athlete, setAthlete] = useState(initial.athlete ?? people[0].athlete.id);
  const [prog, setProg] = useState(initial.prog ?? null);
  const [app, setApp] = useState(null), [step, setStep] = useState(0), [err, setErr] = useState(null), [answers, setAnswers] = useState({}), [busy, setBusy] = useState(false);
  const [promoIn, setPromoIn] = useState(''), [promo, setPromo] = useState(null), [promoErr, setPromoErr] = useState(null);
  const cur = useLoad(() => (initial.continue ? api.get(`/academy/applications/${initial.continue}`) : Promise.resolve(null)), [initial.continue]);
  const a = app ?? cur.data;
  const progId = prog?.id ?? cur.data?.programme_id;
  const forId = a?.athlete_id ?? athlete;
  const detail = useLoad(() => (progId ? api.get(`/academy/programmes/${progId}`) : Promise.resolve(null)), [progId]);
  const d = detail.data, v = d?.version, qs = v?.questions ?? [];
  const steps = qs.length ? WIZ : WIZ.filter((s) => s !== 'Questions');
  const name = steps[step];
  const agreements = useLoad(() => (progId && name === 'Agreements' ? api.get(`/academy/programmes/${progId}/agreements`, { athlete_id: forId }).catch(() => []) : Promise.resolve(null)), [progId, name, forId]);
  const quote = useLoad(() => (progId && (name === 'Price' || name === 'Confirm') ? api.get(`/academy/programmes/${progId}/quote`, { athlete_id: forId, promo_code: promo || undefined }).catch((e) => { if (promo) { setPromoErr(explain(e)); setPromo(null); } return null; }) : Promise.resolve(null)), [progId, name, forId, promo]);
  const mine = people.find((x) => x.athlete.id === forId);
  const existing = (mine?.applications ?? []).find((x) => x.programme_id === progId && OPEN.includes(x.stage));
  const full = d?.capacity && d.seats_taken >= d.capacity;
  const go = (n) => { setErr(null); setStep(n); };
  const begin = async () => {
    setErr(null); setBusy(true);
    try {
      let row = a ?? existing;
      if (!row) row = await api.post(`/academy/programmes/${progId}/applications`, { athlete_id: athlete, idempotency_key: `enq-${progId.slice(0, 8)}-${athlete.slice(0, 8)}-${Date.now()}` });
      setApp(row); go(1);
    } catch (e) { setErr(explain(e)); } finally { setBusy(false); }
  };
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const row = a ?? existing;
      const r = await api.post(`/academy/applications/${row.id}/submit`, { row_version: row.row_version, answers, promo_code: promo || undefined });
      toast(r.stage === 'enrolled' ? 'You are enrolled 🎉' : r.stage === 'waitlisted' ? 'You are on the waitlist' : 'Application sent — the academy will be in touch');
      onClose();
    } catch (e) {
      setErr(e?.details?.code === 'agreements_required' || /agreements/i.test(e.message) ? 'Please read and agree to the agreements first.' : explain(e));
      if (e.status === 409) { try { const fresh = await api.get(`/academy/applications/${(a ?? existing).id}`); setApp(fresh); } catch { /* keep */ } }
    } finally { setBusy(false); }
  };
  return (
    <Sheet visible onClose={onClose} title={d?.title ?? 'Apply'}>
      {!d ? <Loading /> : (
        <View style={{ gap: 12 }}>
          <Stepper steps={steps} current={step} />
          {err ? <View style={{ padding: 12, borderRadius: 14, backgroundColor: c.redSoft }} accessibilityRole="alert"><T color={c.red} weight="800">{err}</T></View> : null}
          {name === 'Programme' ? (
            <View style={{ gap: 10 }}>
              <T color={c.mute}>{d.organisation.name}{d.organisation.city ? ` · ${d.organisation.city}` : ''}</T>
              {d.description ? <T>{d.description}</T> : null}
              <Block title="Details">
                <T size={13}>{lab(FORMATS, d.format)} · {d.sport} · {lab(FOCUS, d.focus)}</T>
                {d.age_min != null ? <T size={13}>Ages {d.age_min}–{d.age_max ?? '+'}</T> : null}
                {d.starts_on ? <T size={13}>📅 {when(d.starts_on)}{d.ends_on ? ` – ${when(d.ends_on)}` : ''}{d.cadence ? ` · ${d.cadence}` : ''}</T> : null}
                {d.equipment ? <T size={13}>🎒 Bring: {d.equipment}</T> : null}
                <T size={13} weight="800">{priceLine(v)}</T>
              </Block>
              <Meter filled={d.seats_taken} capacity={d.capacity} waitlisted={d.waitlisted} />
              {full ? <T size={13} weight="700">This programme is full. You can join the waitlist; we will offer a place if one opens, in the order people joined.</T> : null}
              {people.length > 1 && !a ? <><T weight="800" size={13}>Who is this for?</T><View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{people.map((x) => <Chip key={x.athlete.id} label={x.athlete.is_me ? 'Me' : x.athlete.display_name} active={athlete === x.athlete.id} onPress={() => setAthlete(x.athlete.id)} />)}</View></> : null}
              {existing && !a ? <T size={13} color={c.mute}>You already have an application here ({STAGE[existing.stage]}). You can continue it.</T> : null}
              <Btn title={a || existing ? 'Continue' : full ? 'Join the waitlist' : 'Start application'} onPress={begin} loading={busy} />
            </View>
          ) : null}
          {name === 'Questions' ? (
            <FormSheet inline visible initial={answers} submitLabel="Next: agreements" onBack={() => go(0)} onClose={() => {}}
              fields={qs.map((q) => ({ key: q.key, label: q.label, optional: !q.required, type: q.type === 'longtext' ? 'multiline' : q.type === 'yesno' ? 'switch' : q.type === 'choice' ? 'chips' : q.type === 'number' ? 'stepper' : q.type === 'date' ? 'date' : 'text', options: q.options, min: 0, max: 99 }))}
              onSubmit={async (x) => { setAnswers(x); go(step + 1); }} />
          ) : null}
          {name === 'Agreements' ? (
            <View style={{ gap: 10 }}>
              {!agreements.data ? <Loading /> : agreements.data.length ? agreements.data.map((g) => (
                <View key={g.version_id} style={{ gap: 6, padding: 12, borderRadius: 16, backgroundColor: c.bg }}>
                  <T weight="800">{g.title} <T size={12} color={c.mute}>v{g.version}</T></T><T size={13}>{g.body}</T>
                  <Btn small title="I have read and agree" onPress={async () => { try { await api.post(`/policy-versions/${g.version_id}/acknowledge`, { athlete_id: forId, text_sha256: g.body_sha256 }); agreements.reload(); } catch (e) { setErr(explain(e)); } }} style={{ alignSelf: 'flex-start' }} />
                </View>
              )) : <T color={c.mute}>✓ Nothing to agree to, or you have already agreed.</T>}
              {forId !== people[0].athlete.id ? <T size={11} color={c.mute}>You are agreeing on behalf of your child as their verified guardian.</T> : null}
              <View style={{ flexDirection: 'row', gap: 8 }}><Btn title="Back" color={c.paper} ink={c.ink} onPress={() => go(step - 1)} style={{ flex: 1 }} /><Btn title="Next: price" onPress={() => go(step + 1)} disabled={!!agreements.data?.length} style={{ flex: 2 }} /></View>
            </View>
          ) : null}
          {name === 'Price' ? (
            <View style={{ gap: 10 }}>
              {!quote.data ? <Loading /> : (
                <Block title="What you will pay">
                  {quote.data.lines.length ? quote.data.lines.map((l, i) => (
                    <View key={i} style={{ flexDirection: 'row', gap: 8 }}><T size={14} style={{ flex: 1 }}>{l.kind === 'instalment' ? 'Instalment' : l.kind === 'registration' ? 'Joining fee' : l.kind[0].toUpperCase() + l.kind.slice(1)} · due {when(l.due_on)}{l.discount_minor > 0 ? ` · ${l.discount_reason === 'sibling' ? 'sibling' : 'second programme'} discount ${moneyIn(l.discount_minor, l.currency)}` : ''}</T><T weight="800">{moneyIn(l.amount_minor, l.currency)}</T></View>
                  )) : <T>This programme is free.</T>}
                  <View style={{ flexDirection: 'row', borderTopWidth: 1, borderColor: c.line, paddingTop: 8 }}><T weight="800" style={{ flex: 1 }}>Total</T><T weight="800">{moneyIn(quote.data.total_minor, quote.data.currency)}</T></View>
                  {quote.data.billing_model !== 'free' ? (
                    <View style={{ gap: 6 }}>
                      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                        <View style={{ flex: 1 }}><Field value={promoIn} onChangeText={setPromoIn} placeholder="Promo code (optional)" accessibilityLabel="Promo code" /></View>
                        <Btn small title="Apply" color={c.paper} ink={c.ink} onPress={() => { setPromoErr(null); setPromo(promoIn.trim() || null); }} />
                      </View>
                      {quote.data.promo_applied ? <T size={13} weight="700" color={c.lime}>✓ Code {quote.data.promo_code} applied</T> : null}
                      {promoErr ? <T size={13} weight="700" color={c.red} accessibilityRole="alert">{promoErr}</T> : null}
                      {quote.data.discount_applied && !quote.data.promo_applied ? <T size={12} color={c.mute}>A family discount is already applied. A code only helps if it saves more.</T> : null}
                    </View>
                  ) : null}
                  <T size={12} color={c.mute}>{quote.data.note}</T>
                  {quote.data.renewal_terms ? <T size={12} color={c.mute}>Renewal: {quote.data.renewal_terms}</T> : null}
                </Block>
              )}
              <View style={{ flexDirection: 'row', gap: 8 }}><Btn title="Back" color={c.paper} ink={c.ink} onPress={() => go(step - 1)} style={{ flex: 1 }} /><Btn title="Next: confirm" onPress={() => go(step + 1)} style={{ flex: 2 }} /></View>
            </View>
          ) : null}
          {name === 'Confirm' ? (
            <View style={{ gap: 10 }}>
              <Block title="Please check">
                <T size={14}>For: <T weight="800" size={14}>{mine?.athlete.is_me ? 'Me' : mine?.athlete.display_name}</T></T>
                <T size={14}>Programme: <T weight="800" size={14}>{d.title}</T></T>
                <T size={14}>{full ? 'You will join the waitlist.' : d.admission_mode === 'direct' ? 'You will be enrolled straight away.' : 'The academy will review your application and reply.'}</T>
                {quote.data ? <T size={14}>First payment: <T weight="800" size={14}>{moneyIn(quote.data.today_minor, quote.data.currency)}</T> after enrolment</T> : null}
              </Block>
              <View style={{ flexDirection: 'row', gap: 8 }}><Btn title="Back" color={c.paper} ink={c.ink} onPress={() => go(step - 1)} style={{ flex: 1 }} /><Btn title={full ? 'Join the waitlist' : d.admission_mode === 'direct' ? 'Confirm & enrol' : 'Send application'} onPress={submit} loading={busy} style={{ flex: 2 }} /></View>
            </View>
          ) : null}
        </View>
      )}
    </Sheet>
  );
}

/** A compact entry shown in "My organisations" that opens the full family screen. */
export function MyAcademyCard({ onOpen }) {
  const fam = useLoad(() => api.get('/me/academy').catch(() => null), []);
  const d = fam.data;
  if (!d) return null;
  const all = d.people;
  const enrolled = all.reduce((t, p) => t + p.enrolments.filter((e) => e.status === 'enrolled').length, 0);
  const open = all.reduce((t, p) => t + p.applications.filter((a) => OPEN.includes(a.stage)).length, 0);
  const attention = all.reduce((t, p) => t + p.applications.filter((a) => a.stage === 'offered').length + p.to_do.length + p.charges.filter((x) => x.overdue).length, 0);
  const due = Object.values(d.due ?? {});
  return (
    <Pressable onPress={onOpen} accessibilityRole="button" accessibilityLabel={`My academy. ${enrolled} programmes, ${open} open applications${attention ? `, ${attention} need attention` : ''}`}
      style={{ marginTop: 12, padding: 16, borderRadius: 20, backgroundColor: attention ? c.sunSoft : c.paper, borderWidth: 1, borderColor: c.line, gap: 4 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><T size={20}>🏅</T><T weight="800" size={17} style={{ flex: 1 }}>My academy</T>{attention ? <Tag label={`${attention} need you`} color={c.orangeSoft} /> : <Tag label="Open" />}</View>
      <T size={13} color={c.mute}>{enrolled} programme{enrolled === 1 ? '' : 's'} · {open} open application{open === 1 ? '' : 's'}{all.length > 1 ? ` · ${all.length - 1} child${all.length === 2 ? '' : 'ren'}` : ''}{due.map((x) => ` · ${moneyIn(x.due_minor, x.currency)} due`).join('')}</T>
    </Pressable>
  );
}
