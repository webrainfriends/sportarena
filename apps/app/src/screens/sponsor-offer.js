import React, { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { useSession } from '../session';
import { Avatar, Bubble, Btn, Card, Chip, Empty, Field, H1, Loading, Row, Screen, Section, T } from '../ui';
import { Counter, DateField, DateRangeField, Stepper } from '../pickers';
import { CurrencyDropdown } from '../currency-dropdown';
import { c } from '../theme';
import { asSponsorRole } from '../sponsor-roles';
import { explain, LoadError } from '../access';
import { buildLines, CADENCES, CHANNELS, KINDS, lineProblems, MAX_LINES, money, newLine, SERVICES } from '../offer-lines';

// One place to make a sponsorship offer (#309): who, what (any mix of cash / goods / service / endorsement), terms, then a review that shows
// the exact dated schedule the server will create. Sending an offer moves no money; every payment starts as unconfirmed until the recipient says so.
const STEPS = ['Who', 'What', 'Terms', 'Review'];
const TARGETS = [{ type: 'athlete', label: 'Athlete' }, { type: 'team', label: 'Team' }, { type: 'event', label: 'Event' }, { type: 'organisation', label: 'Organisation' }, { type: 'group', label: 'Group' }];
const NOUN = { athlete: 'athlete', team: 'team', event: 'event', organisation: 'organisation', group: 'group' };
const ROLE_CAN_BUDGET = ['manager', 'finance', 'approver', 'auditor'];
const when = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const deviceZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };
const newRef = () => `ofr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const what = (o) => (o.kind === 'money' ? money(o.amount_cents, o.currency) : o.kind === 'goods' ? `${o.quantity} to deliver` : o.kind === 'service' ? `${o.quantity} funded` : 'Evidence of promotion');

/** Search-and-pick the recipient for the chosen kind of target. Names only; never contact details or rosters. */
function TargetPicker({ type, onPick }) {
  const [q, setQ] = useState('');
  const list = useLoad(async () => {
    const term = q.trim() || undefined;
    if (type === 'athlete') return (await api.get('/sponsorable-athletes', { limit: 20, q: term })).map((a) => ({ type, id: a.id, name: a.display_name, sub: [a.sports?.join(', '), a.pitch].filter(Boolean).join(' · '), user: a }));
    if (type === 'team') return (await api.get('/teams', { limit: 20, q: term })).map((t) => ({ type, id: t.id, name: t.name, sub: [t.sport, t.city].filter(Boolean).join(' · '), emoji: t.emoji }));
    if (type === 'event') return (await api.get('/events', { limit: 50, q: term })).map((e) => ({ type, id: e.id, name: e.name, sub: [e.sport, e.starts_on].filter(Boolean).join(' · '), emoji: e.banner_emoji }));
    return (await api.get('/sponsorship-beneficiaries', { type, limit: 20, q: term })).map((o) => ({ type, id: o.id, name: o.name, sub: [o.organisation_name, o.kind, o.city].filter(Boolean).join(' · '), emoji: type === 'group' ? '👥' : '🏟️' }));
  }, [type, q]);
  return (
    <View style={{ gap: 8 }}>
      <Field label={`Search ${NOUN[type]}s`} value={q} onChangeText={setQ} placeholder="Type a name…" accessibilityLabel={`Search ${NOUN[type]}s by name`} />
      {list.loading && !list.data ? <Loading /> : list.error ? <LoadError error={list.error} onRetry={list.reload} />
        : list.data?.length ? list.data.map((t) => <Row key={t.id} left={t.user ? <Avatar user={t.user} /> : <Bubble emoji={t.emoji ?? '🤝'} color={c.sun} />} title={t.name} sub={t.sub} right={<Btn small title="Choose" color={c.pink} onPress={() => onPick(t)} accessibilityLabel={`Choose ${t.name}`} />} />)
          : <Empty emoji="🔎" title={`No ${NOUN[type]}s found`} sub={type === 'athlete' ? 'Athletes only appear here after they opt in to sponsors.' : type === 'organisation' || type === 'group' ? 'Organisations appear once an owner or admin opens them to sponsors.' : 'Try a different name.'} />}
    </View>
  );
}

function DateList({ dates, onChange, min, max }) {
  return (
    <View style={{ gap: 8 }}>
      {dates.map((d, i) => (
        <View key={i} style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}>
          <View style={{ flex: 1 }}><DateField label={`Date ${i + 1}`} value={d} min={min} max={max} onChange={(x) => onChange(dates.map((y, j) => (j === i ? x : y)))} /></View>
          {dates.length > 1 ? <Btn small title="Remove" color={c.paper} ink={c.red} onPress={() => onChange(dates.filter((_, j) => j !== i))} accessibilityLabel={`Remove date ${i + 1}`} /> : null}
        </View>))}
      {dates.length < 120 ? <Btn small title="＋ Add a date" color={c.paper} ink={c.ink} style={{ alignSelf: 'flex-start' }} onPress={() => onChange([...dates, undefined])} /> : null}
    </View>
  );
}

function LineCard({ line: l, set, remove, min, max, fixedCurrency, issues }) {
  const k = KINDS.find((x) => x.kind === l.kind);
  const cur = fixedCurrency ?? l.currency;
  const when1 = l.kind === 'endorsement' ? 'Evidence due' : l.kind === 'goods' ? 'Delivery' : l.kind === 'service' ? 'Available from' : 'First due';
  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <T weight="900" style={{ flex: 1 }} accessibilityRole="header">{k.emoji} {k.title}</T>
        <Btn small title="Remove" color={c.paper} ink={c.red} onPress={remove} accessibilityLabel={`Remove ${k.title} line`} />
      </View>
      <View style={{ gap: 10, marginTop: 8 }}>
        <Field label="Name this contribution" value={l.label} onChangeText={(x) => set({ label: x })} maxLength={160} placeholder={k.kind === 'goods' ? 'e.g. Match kits' : k.kind === 'service' ? 'e.g. Coaching sessions' : undefined} />
        {l.kind === 'money' ? (
          <>
            <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
              <Chip label="Each payment" active={l.mode === 'each'} onPress={() => set({ mode: 'each' })} />
              <Chip label="Total, split across payments" active={l.mode === 'total'} onPress={() => set({ mode: 'total' })} />
            </View>
            <Field label={l.mode === 'total' ? `Total amount (${cur})` : `Amount each payment (${cur})`} value={l.amount} onChangeText={(x) => set({ amount: x.replace(/[^0-9.,]/g, '') })} keyboardType="decimal-pad" placeholder={`${cur} 0`} />
            {fixedCurrency ? <T size={12} color={c.mute}>The currency follows the budget you chose ({fixedCurrency}).</T> : <CurrencyDropdown label="Currency" value={l.currency} onChange={(x) => set({ currency: x })} />}
          </>) : null}
        {l.kind === 'goods' || l.kind === 'service' ? <Counter label={l.kind === 'goods' ? 'Quantity' : 'Sessions, slots or trips funded'} value={l.quantity} min={1} max={100000} onChange={(x) => set({ quantity: x })} /> : null}
        {l.kind === 'goods' ? <Field label="Unit (optional)" value={l.unit} onChangeText={(x) => set({ unit: x })} maxLength={30} placeholder="kits, pairs, boxes…" /> : null}
        {l.kind === 'service' ? (
          <View style={{ gap: 6 }}><T weight="600" size={12} color={c.mute}>WHICH SERVICE</T>
            <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{SERVICES.map((s) => <Chip key={s.value} label={s.label} active={l.service_type === s.value} onPress={() => set({ service_type: s.value })} />)}</View>
            <T size={12} color={c.mute}>Funding a service pays for it; it never gives you access to the recipient's health or other private data.</T></View>) : null}
        {l.kind === 'endorsement' ? (
          <>
            <View style={{ gap: 6 }}><T weight="600" size={12} color={c.mute}>WHO PROMOTES</T>
              <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}><Chip label="The recipient promotes the brand" active={l.promoter === 'recipient'} onPress={() => set({ promoter: 'recipient' })} /><Chip label="The brand promotes the recipient" active={l.promoter === 'sponsor'} onPress={() => set({ promoter: 'sponsor' })} /></View></View>
            <View style={{ gap: 6 }}><T weight="600" size={12} color={c.mute}>WHERE (RIGHTS GRANTED)</T>
              <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{CHANNELS.map((ch) => <Chip key={ch} label={ch} active={l.channels.includes(ch)} onPress={() => set({ channels: l.channels.includes(ch) ? l.channels.filter((x) => x !== ch) : [...l.channels, ch] })} />)}</View></View>
            <Field label="Placement (optional)" value={l.placement} onChangeText={(x) => set({ placement: x })} maxLength={300} placeholder="e.g. Chest and sleeve" />
            <Field label="What counts as approved (optional)" value={l.approval_criteria} onChangeText={(x) => set({ approval_criteria: x })} multiline maxLength={600} />
            <Field label="How logos and content may be used (optional)" value={l.asset_usage} onChangeText={(x) => set({ asset_usage: x })} multiline maxLength={600} />
            <Field label="Exclusivity (optional)" value={l.exclusivity} onChangeText={(x) => set({ exclusivity: x })} multiline maxLength={600} placeholder="e.g. No rival brand in the same category" />
          </>) : null}
        {l.kind !== 'money' ? (
          <View style={{ gap: 6 }}>
            <Field label={`Estimated value in ${cur} (optional)`} value={l.estimate} onChangeText={(x) => set({ estimate: x.replace(/[^0-9.,]/g, '') })} keyboardType="decimal-pad" placeholder={`${cur} 0`} hint="An estimate for reporting only. It is never counted as cash paid." />
            {!fixedCurrency && l.estimate ? <CurrencyDropdown label="Currency of the estimate" value={l.currency} onChange={(x) => set({ currency: x })} /> : null}
          </View>) : null}
        <View style={{ gap: 6 }}><T weight="600" size={12} color={c.mute}>{l.kind === 'money' ? 'PAY AS' : 'SCHEDULE'}</T>
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{CADENCES.map((x) => <Chip key={x.value} label={x.label} active={l.cadence === x.value} onPress={() => set({ cadence: x.value })} />)}</View></View>
        {l.cadence === 'custom'
          ? <DateList dates={l.custom_dates} onChange={(x) => set({ custom_dates: x })} min={min} max={max} />
          : <DateField label={when1} value={l.first_due_on} min={min} max={max} onChange={(x) => set({ first_due_on: x })} />}
        {l.cadence !== 'once' && l.cadence !== 'custom' ? <Counter label="Number of instalments" value={l.instalments} min={2} max={120} onChange={(x) => set({ instalments: x })} /> : null}
        {issues.length ? <T size={12} color={c.red} accessibilityRole="alert">Still to do: {issues.join(', ')}.</T> : null}
      </View>
    </Card>
  );
}

export function SponsorOffer({ target: initialTarget, sponsor_id, billboard_response_id }) {
  const { toast } = useSession();
  const { back, replace } = useNav();
  const brands = useLoad(() => api.get('/sponsors', { mine: true, limit: 50 }), []);
  const [step, setStep] = useState(initialTarget ? 1 : 0);
  const [brandId, setBrandId] = useState(sponsor_id);
  const [type, setType] = useState(initialTarget?.type ?? 'athlete');
  const [target, setTarget] = useState(initialTarget ?? null);
  const [lines, setLines] = useState([]);
  const [period, setPeriod] = useState({});
  const [terms, setTerms] = useState({ objectives: '', deliverables: '', message: '', budget_id: undefined });
  const [preview, setPreview] = useState(null); // { loading, data, error }
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(null);
  const [formError, setFormError] = useState(null);
  const ref = useRef(newRef());
  const zone = useRef(deviceZone());

  const mine = brands.data ?? [];
  const brand = mine.find((b) => b.id === brandId) ?? (mine.length === 1 ? mine[0] : null);
  useEffect(() => { if (!brandId && mine.length === 1) setBrandId(mine[0].id); }, [mine.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const canBudget = brand && ROLE_CAN_BUDGET.includes(asSponsorRole(brand.my_role));
  const budgets = useLoad(() => (canBudget ? api.get('/sponsorship-budgets', { sponsor_id: brand.id, status: 'active', limit: 100 }).then((r) => r.filter((x) => x.kind !== 'program')).catch(() => []) : Promise.resolve([])), [brand?.id, canBudget]);
  const budget = (budgets.data ?? []).find((b) => b.id === terms.budget_id);
  const fixedCurrency = budget?.currency;
  const lastCurrency = lines.at(-1)?.currency ?? 'INR';

  const setLine = (key, patch) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const add = (kind) => lines.length < MAX_LINES && setLines((ls) => [...ls, newLine(kind, lastCurrency)]);
  const built = buildLines(lines, fixedCurrency);
  const periodOk = !!(period.from && period.to);
  const whatProblem = built.problem ?? (!periodOk ? 'Pick the period of the sponsorship.' : null);
  const termsProblem = type === 'athlete' && !terms.deliverables.trim() ? 'Say what you expect from the athlete.' : null;
  const hasRecurring = lines.some((l) => l.cadence !== 'once' && l.cadence !== 'custom');

  const body = () => ({
    sponsor_id: brand.id, target_type: target.type, target_id: target.id, starts_on: period.from, ends_on: period.to, timezone: zone.current, lines: built.lines, client_ref: ref.current, billboard_response_id,
    objectives: terms.objectives.trim() || undefined, deliverables: terms.deliverables.trim() || undefined, message: terms.message.trim() || undefined, budget_id: terms.budget_id,
  });

  // the review shows the server's own schedule for exactly these lines, so what is previewed is what will be created
  const runPreview = async () => {
    setPreview({ loading: true });
    try { setPreview({ data: await api.post('/sponsorship-schedule/preview', { lines: built.lines, starts_on: period.from, ends_on: period.to }) }); }
    catch (error) { setPreview({ error }); }
  };
  const go = (n) => {
    setFormError(null);
    if (n === 3) { if (whatProblem) return setFormError(whatProblem); if (termsProblem) return setFormError(termsProblem); runPreview(); }
    setStep(n);
  };

  const send = async () => {
    setSending(true); setFormError(null);
    try {
      const r = await api.post('/sponsorships', body());
      setSent(r);
      toast(r.budget_approval === 'pending' ? 'Saved — waiting for a second approver' : r.replayed ? 'Offer was already sent' : 'Offer sent');
    } catch (e) {
      if (e.status) ref.current = newRef(); // the server answered and made nothing: a corrected form is a new send. A lost connection keeps the reference, so a retry can never make two offers
      setFormError(explain(e));
    } finally { setSending(false); }
  };

  if (brands.loading && !brands.data) return <Screen><H1>New offer</H1><Loading /></Screen>;
  if (brands.error) return <Screen><H1>New offer</H1><LoadError error={brands.error} onRetry={brands.reload} /></Screen>;
  if (!mine.length) return <Screen><H1>New offer</H1><Empty emoji="🏷️" title="Create a brand first" sub="Offers are made on behalf of a brand. Create one, or ask an organisation manager to invite you to theirs." /><Btn title="Back to Sponsor home" color={c.violet} onPress={back} /></Screen>;

  if (sent) {
    return (
      <Screen>
        <H1>{sent.budget_approval === 'pending' ? 'Waiting for approval' : 'Offer sent'}</H1>
        <Card color={c.limeSoft}>
          <T weight="800" accessibilityRole="alert">{sent.budget_approval === 'pending' ? 'It is above the budget threshold, so a second approver must approve it before the recipient is told.' : `${target.name} has been notified and can accept, counter or decline.`}</T>
          <T size={13} color={c.mute} style={{ marginTop: 6 }}>Sending an offer does not move any money. Payments start as unconfirmed and only count once the recipient confirms them.</T>
        </Card>
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          <Btn title="Open the agreement" color={c.violet} onPress={() => replace('SponsorDeal', { id: sent.id })} />
          <Btn title="Back to Sponsor home" color={c.paper} ink={c.ink} onPress={back} />
        </View>
      </Screen>
    );
  }

  const nav = (next, label) => (
    <View style={{ gap: 8, marginTop: 14 }}>
      {formError ? <Card color={c.redSoft}><T size={13} accessibilityRole="alert">{formError}</T></Card> : null}
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
        <Btn title={step === 0 ? 'Cancel' : 'Back'} color={c.paper} ink={c.ink} onPress={() => (step === 0 ? back() : go(step - 1))} />
        {next ? <Btn title={label} color={c.pink} onPress={next} /> : null}
      </View>
    </View>
  );

  return (
    <Screen>
      <H1>New offer</H1>
      <Stepper steps={STEPS} current={step} onJump={(i) => go(i)} />

      {step === 0 ? (
        <>
          <Section title="From which brand?" color={c.violet}>
            {mine.length > 1 ? <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{mine.map((b) => <Chip key={b.id} label={`${b.emoji ?? ''} ${b.name}`.trim()} active={brand?.id === b.id} onPress={() => { setBrandId(b.id); setTerms((t) => ({ ...t, budget_id: undefined })); }} />)}</View>
              : <Card><T weight="800">{brand?.emoji} {brand?.name}</T></Card>}
          </Section>
          <Section title="To whom?" color={c.pink}>
            {target ? (
              <Card color={c.sunSoft}><View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <View style={{ flex: 1 }}><T weight="900">{target.name}</T><T size={12} color={c.mute}>{TARGETS.find((x) => x.type === target.type)?.label}{target.sub ? ` · ${target.sub}` : ''}</T></View>
                <Btn small title="Change" color={c.paper} ink={c.ink} onPress={() => setTarget(null)} />
              </View></Card>
            ) : (
              <>
                <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{TARGETS.map((x) => <Chip key={x.type} label={x.label} active={type === x.type} onPress={() => setType(x.type)} />)}</View>
                <TargetPicker type={type} onPick={setTarget} />
              </>)}
          </Section>
          {formError ? <Card color={c.redSoft}><T size={13} accessibilityRole="alert">{formError}</T></Card> : null}
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 14 }}>
            <Btn title="Cancel" color={c.paper} ink={c.ink} onPress={back} />
            <Btn title="Next: what you offer" color={c.pink} onPress={() => (!brand ? setFormError('Choose a brand.') : !target ? setFormError('Choose who the offer is for.') : go(1))} />
          </View>
        </>) : null}

      {step === 1 ? (
        <>
          <Section title="Contributions" color={c.sun}>
            <T size={13} color={c.mute}>Offer any mix: cash, goods, a funded service, or an endorsement. Each line has its own schedule.</T>
            {lines.length ? lines.map((l) => <LineCard key={l.key} line={l} set={(p) => setLine(l.key, p)} remove={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} min={period.from} max={period.to} fixedCurrency={fixedCurrency} issues={formError ? lineProblems(l) : []} />)
              : <Empty emoji="🎁" title="Nothing offered yet" sub="Add the first contribution below." />}
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>{KINDS.map((k) => <Btn key={k.kind} small title={`＋ ${k.add}`} color={c.paper} ink={c.ink} onPress={() => add(k.kind)} disabled={lines.length >= MAX_LINES} accessibilityLabel={`Add a ${k.title} contribution`} />)}</View>
          </Section>
          <Section title="Period" color={c.cyan}>
            <DateRangeField label="Sponsorship period" from={period.from} to={period.to} onChange={setPeriod} hint={hasRecurring ? 'Repeating payments must fall inside this period. Both the first and last day count.' : 'Both the first and last day count.'} />
          </Section>
          {nav(() => (whatProblem ? setFormError(whatProblem) : go(2)), 'Next: terms')}
        </>) : null}

      {step === 2 ? (
        <>
          <Section title="Terms" color={c.violet}>
            <View style={{ gap: 10 }}>
              <Field label="Objectives (optional)" value={terms.objectives} onChangeText={(x) => setTerms({ ...terms, objectives: x })} multiline maxLength={1000} />
              <Field label={type === 'athlete' ? 'What you expect from the athlete' : 'What you expect in return (optional)'} value={terms.deliverables} onChangeText={(x) => setTerms({ ...terms, deliverables: x })} multiline maxLength={1500} />
              <Field label="Personal message (optional)" value={terms.message} onChangeText={(x) => setTerms({ ...terms, message: x })} multiline maxLength={1000} />
            </View>
          </Section>
          {(budgets.data ?? []).length ? (
            <Section title="Budget" color={c.mint}>
              <T size={13} color={c.mute}>Optional. The offer is then limited by what the budget has authorized, and its cash uses the budget's currency.</T>
              <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{budgets.data.map((b) => <Chip key={b.id} label={b.name} active={terms.budget_id === b.id} onPress={() => setTerms({ ...terms, budget_id: terms.budget_id === b.id ? undefined : b.id })} />)}</View>
            </Section>) : null}
          {nav(() => go(3), 'Next: review')}
        </>) : null}

      {step === 3 ? (
        <>
          <Section title="Offer" color={c.sun}>
            <Card><T weight="900">{brand.name} → {target.name}</T><T size={12} color={c.mute}>{period.from ? `${when(period.from)} – ${when(period.to)}` : ''}</T></Card>
          </Section>
          <Section title="Schedule preview" color={c.cyan}>
            {preview?.loading || !preview ? <Loading /> : preview.error ? (
              <Card color={c.redSoft}>
                <T weight="800" accessibilityRole="alert">{preview.error.status === 400 ? 'Check the dates and amounts' : 'Could not build the preview'}</T>
                <T size={13} style={{ marginTop: 4 }}>{explain(preview.error)}</T>
                <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                  {preview.error.status === 400 ? <Btn small title="Fix it" color={c.pink} onPress={() => go(1)} /> : <Btn small title="Retry" color={c.pink} onPress={runPreview} />}
                </View>
              </Card>
            ) : (
              <>
                {preview.data.occurrences.map((x) => (
                  <View key={`${x.line}-${x.seq}`} style={{ borderLeftWidth: 3, borderLeftColor: c.pink, paddingLeft: 10, marginVertical: 3 }}>
                    <T size={13} accessibilityLabel={`${when(x.due_on)}, ${x.label}, ${what(x)}`}><T size={13} weight="800">{when(x.due_on)}</T> · {x.label} · {what(x)}</T>
                  </View>))}
                <Card>
                  {Object.entries(preview.data.committed).map(([cur, v]) => <View key={cur} style={{ flexDirection: 'row', justifyContent: 'space-between' }}><T>Committed cash</T><T weight="900">{money(v, cur)}</T></View>)}
                  {!Object.keys(preview.data.committed).length ? <T>No cash in this offer.</T> : null}
                  {Object.entries(preview.data.estimated_not_cash).map(([cur, v]) => <View key={cur} style={{ flexDirection: 'row', justifyContent: 'space-between' }}><T color={c.mute}>Estimated, not cash</T><T weight="900" color={c.mute}>{money(v, cur)}</T></View>)}
                  <T size={12} color={c.mute} style={{ marginTop: 4 }}>{preview.data.occurrences.length} dues. Each currency is shown on its own and never added to another.</T>
                </Card>
              </>)}
          </Section>
          <Card color={c.sunSoft}><T size={13} accessibilityRole="text">Sending only makes the offer. It does not move money; payments show as reported until the recipient confirms them.</T></Card>
          {formError ? <Card color={c.redSoft}><T size={13} accessibilityRole="alert">{formError}</T></Card> : null}
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 14, gap: 8 }}>
            <Btn title="Back" color={c.paper} ink={c.ink} onPress={() => go(2)} />
            <Btn title={formError && !sending ? 'Try sending again' : 'Send offer'} color={c.pink} loading={sending} disabled={sending || !preview?.data} onPress={send} />
          </View>
        </>) : null}
    </Screen>
  );
}
