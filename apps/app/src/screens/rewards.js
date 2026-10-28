// Rewards (issue #509): one place for a member's points, invites and statement; one console component every business embeds to run its programme;
// one checkout sheet that spends points on any bill. All of it calls the loyalty capabilities (REST/MCP share them); the server enforces every rule.
import React, { useState } from 'react';
import { Platform, Share, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Btn, Card, Chip, Empty, ErrorBox, Field, H1, Loading, Row, Screen, Section, Sheet, StatPill, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { Counter } from '../pickers';
import { c } from '../theme';
import { moneyIn } from '../vtime';
import { locale } from '../locale';

const num = (n) => Number(n ?? 0).toLocaleString(locale);
const day = (d) => (d ? new Date(d).toLocaleDateString(locale) : '');
const pct = (bp) => `${bp / 100}%`;
const KIND = { platform: 'Gotmygame', venue: 'Venue', organisation: 'Academy / club', coach: 'Coach', event: 'Event' };
const STATUS = { draft: [c.sunSoft, 'draft'], active: [c.mint, 'running'], paused: [c.sunSoft, 'paused'], ended: [c.violetSoft, 'ended'] };
const REF = { registered: 'Signed up', qualified: 'Qualified — reward on its way', rewarded: 'Rewarded', under_review: 'Under review', blocked: 'Not eligible', void: 'Cancelled (payment refunded)' };
const SIGN = (n) => (n > 0 ? `+${n}` : `${n}`);

/** Copy on the web, the share sheet on phones and tablets. */
export async function shareText(text, toast) {
  try {
    if (Platform.OS === 'web') { await navigator.clipboard.writeText(text); toast('Copied — paste it to your friend'); } else await Share.share({ message: text });
  } catch { /* the person closed the share sheet */ }
}

const ruleLine = (r, cur) => `${r.label || r.event_label}: ${r.mode === 'percent' ? `${pct(r.percent_bp)} back` : `${r.points} points`}${r.min_spend_minor ? ` on ${moneyIn(r.min_spend_minor, cur)}+` : ''}`;

/** A programme in plain words, with the member's own lots and expiry dates. */
function ProgrammeSheet({ id, onClose }) {
  const p = useLoad(() => api.get(`/loyalty/programmes/${id}`), [id]);
  const d = p.data;
  return (
    <Sheet visible onClose={onClose} title={d?.name ?? 'Programme'}>
      {p.loading && !d ? <Loading /> : p.error ? <ErrorBox error={p.error} onRetry={p.reload} /> : (
        <View style={{ gap: 10 }}>
          <T color={c.mute} size={13}>{KIND[d.owner_kind]} · {d.owner_name} · {d.funding_owner === 'sponsor' ? 'sponsor-funded' : d.funding_owner === 'platform' ? 'funded by Gotmygame' : 'funded by the business'}</T>
          <T weight="800" size={22}>{num(d.my_points)} {d.unit} <T size={14} color={c.mute}>= {moneyIn(d.my_points, d.currency)}</T></T>
          {d.my_lots.length ? d.my_lots.map((l, k) => <T key={k} size={13}>{num(l.points)} expire {day(l.expires_at)}</T>) : null}
          <T weight="700" style={{ marginTop: 4 }}>How you earn</T>
          {d.earn?.length ? d.earn.map((r) => <T key={r.key} size={13}>• {ruleLine(r, d.currency)}</T>) : <T size={13} color={c.mute}>No earning rule right now.</T>}
          {d.referral ? <T size={13}>• Invite a friend: you get {d.referral.referrer_points}, they get {d.referral.invitee_points}, once they {d.referral.qualifying_label.toLowerCase()}{d.referral.min_spend_minor ? ` (${moneyIn(d.referral.min_spend_minor, d.currency)}+)` : ''} and {d.referral.holdback_days} days pass.</T> : null}
          <T weight="700" style={{ marginTop: 4 }}>How you spend</T>
          {d.redeem?.purposes.length ? <T size={13}>• On: {d.redeem.purposes.map((x) => x.label).join(', ')} — up to {pct(d.redeem.max_redeem_bp)} of one bill.{d.redeem.restore_on_cancel === 'full' ? ' Points come back if the payment is cancelled.' : ' Points are not returned if the payment is cancelled.'}</T> : <T size={13} color={c.mute}>Not spendable on a bill yet.</T>}
          <T size={13} color={c.mute}>Points expire {d.expiry_months} months after you earn them. {d.youth === 'guardian_linked' ? 'Young people join through a verified guardian.' : 'Not available to young people.'}</T>
        </View>
      )}
    </Sheet>
  );
}

function BalanceCard({ b, onOpen }) {
  const soon = b.expiring_soon > 0;
  return (
    <Card onPress={onOpen} accessibilityLabel={`${b.name}, ${b.points} points`} color={c.paper} style={{ flexGrow: 1, flexBasis: 260 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}><T weight="700" style={{ flex: 1 }}>{b.emoji ?? '⭐'} {b.name}</T><Tag label={KIND[b.owner_kind]} /></View>
      <T size={12} color={c.mute}>{b.owner_name}</T>
      <T weight="800" size={30} style={{ marginTop: 6 }}>{num(b.points)}<T size={14} color={c.mute}> {b.unit}</T></T>
      <T size={13} color={c.mute}>Worth {moneyIn(b.value_minor, b.currency)} on your next payment there</T>
      {soon ? <Tag label={`${b.expiring_soon} expire by ${day(b.next_expiry)}`} color={c.sunSoft} style={{ marginTop: 6, alignSelf: 'flex-start' }} /> : <T size={12} color={c.mute} style={{ marginTop: 4 }}>Next expiry {day(b.next_expiry)}</T>}
    </Card>
  );
}

function Invite({ onChange }) {
  const { toast } = useSession();
  const codes = useLoad(() => api.get('/me/referral-codes'), []);
  const progs = useLoad(() => api.get('/loyalty/programmes', { view: 'referrals' }), []);
  const mine = useLoad(() => api.get('/me/referrals'), []);
  const [pick, setPick] = useState(false);
  const [make, setMake] = useState(null);
  const [enter, setEnter] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const reload = () => { codes.reload(); mine.reload(); onChange?.(); };
  const live = (codes.data ?? []).filter((k) => !k.revoked_at);
  const claim = async () => {
    setBusy(true);
    try { const r = await api.post('/referrals/claim', { code }); toast(r.status === 'under_review' ? 'Code accepted — it will be checked before any reward' : `Code accepted. Your reward comes after you ${r.qualifying_event?.toLowerCase() ?? 'take part'}`); setEnter(false); setCode(''); reload(); } catch (e) { toast(e.message); } finally { setBusy(false); }
  };
  return (
    <Section title="Invite friends" color={c.mint}>
      <T size={13} color={c.mute}>Share a code. You and your friend are rewarded only after they complete the programme's first qualifying action, and a short holdback passes. Signing up alone earns nothing.</T>
      {live.map((k) => (
        <Card key={k.id}>
          <T size={12} color={c.mute}>{k.programme_name}{k.campaign ? ` · ${k.campaign}` : ''}{k.source ? ` · ${k.source}` : ''}</T>
          <T weight="800" size={26} style={{ letterSpacing: 3 }} accessibilityLabel={`Referral code ${k.code.split('').join(' ')}`}>{k.code}</T>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
            <StatPill label="Signed up" value={String(k.signed_up)} /><StatPill label="Qualified" value={String(k.qualified)} /><StatPill label="Rewarded" value={String(k.rewarded)} />
          </View>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <Btn small title="Share" onPress={() => shareText(`Join me on Gotmygame and we both earn rewards. Use my code ${k.code} (Rewards → Enter a code).`, toast)} />
            <Btn small title="Revoke" color={c.paper} ink={c.red} onPress={async () => { try { await api.del(`/referral-codes/${k.id}`); toast('Code revoked'); reload(); } catch (e) { toast(e.message); } }} />
          </View>
        </Card>
      ))}
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <Btn small title="＋ New invite code" onPress={() => setPick(true)} />
        <Btn small title="I have a code" color={c.violet} onPress={() => setEnter(true)} />
      </View>
      {(mine.data?.invited ?? []).length ? <Section title="Your invites" color={c.mint}>{mine.data.invited.map((r) => <Row key={r.id} title={r.friend_name ?? 'A friend'} sub={`${r.programme_name} · ${day(r.created_at)}`} right={<Tag label={REF[r.status] ?? r.status} />} />)}</Section> : null}
      {(mine.data?.joined_through ?? []).map((r) => <Row key={r.id} title={`You joined through an invite · ${r.programme_name}`} sub={day(r.created_at)} right={<Tag label={REF[r.status] ?? r.status} />} />)}

      <Sheet visible={pick} onClose={() => setPick(false)} title="Which programme?">
        {progs.loading ? <Loading /> : progs.data?.length ? progs.data.map((p) => (
          <Row key={p.id} title={p.name} sub={`${p.owner_name} · you get ${p.referral.referrer_points}, they get ${p.referral.invitee_points}`} onPress={() => { setPick(false); setMake(p); }} />
        )) : <Empty emoji="🎁" title="No invite programmes are running" sub="When a venue, academy or Gotmygame runs one, it shows up here." />}
      </Sheet>
      <FormSheet visible={!!make} onClose={() => setMake(null)} title={`Invite code · ${make?.name ?? ''}`} submitLabel="Create code"
        fields={[{ key: 'campaign', label: 'Who is it for?', type: 'chips', optional: true, options: ['Friends', 'Team-mates', 'Family', 'Club', 'Class'] },
          { key: 'source', label: 'Where will you share it?', type: 'chips', optional: true, options: ['WhatsApp', 'Instagram', 'SMS', 'Email', 'In person'] }]}
        onSubmit={async (v) => { await api.post(`/loyalty/programmes/${make.id}/referral-codes`, v); reload(); return 'Code ready to share'; }} />
      <Sheet visible={enter} onClose={() => setEnter(false)} title="Enter a friend's code">
        <Field label="Code" value={code} onChangeText={(x) => setCode(x.toUpperCase())} placeholder="8 letters and numbers" maxLength={24} />
        <T size={12} color={c.mute}>You can enter one code per programme, soon after you sign up. Your own code can't be used.</T>
        <Btn title="Use this code" onPress={claim} loading={busy} disabled={code.trim().length < 4} />
      </Sheet>
    </Section>
  );
}

function Exchanges({ onDone }) {
  const ex = useLoad(() => api.get('/loyalty/exchange-rules'), []);
  const [rule, setRule] = useState(null);
  const list = ex.data?.available ?? [];
  if (!list.length) return null;
  return (
    <Section title="Exchange" color={c.sky}>
      <T size={13} color={c.mute}>Two businesses agreed you can move points between their programmes. Nothing moves unless you do it.</T>
      {list.map((x) => <Row key={x.id} title={`${x.from_name} → ${x.to_name}`} sub={`${x.rate_bp / 100}% of the value${x.max_points_per_member_month ? ` · up to ${x.max_points_per_member_month} a month` : ''}`} onPress={() => setRule(x)} />)}
      <FormSheet visible={!!rule} onClose={() => setRule(null)} title="Exchange points" submitLabel="Exchange" initial={{ points: 100 }}
        fields={[{ key: 'points', label: `Points to move from ${rule?.from_name}`, type: 'stepper', min: 1, max: 100000, step: 100 }]}
        onSubmit={async (v) => { const r = await api.post('/loyalty/exchange', { rule_id: rule.id, points: v.points, request_key: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}` }); onDone?.(); ex.reload(); return `Moved ${r.points_out} → ${r.points_in} points`; }} />
    </Section>
  );
}

export function Rewards() {
  const bal = useLoad(() => api.get('/me/loyalty'), []);
  const [skip, setSkip] = useState(0);
  const hist = useLoad(() => api.get('/me/loyalty/history', { limit: 25, offset: skip }), [skip]);
  const [open, setOpen] = useState(null);
  const [rows, setRows] = useState([]);
  React.useEffect(() => { if (hist.data) setRows((r) => (skip === 0 ? hist.data : [...r, ...hist.data])); }, [hist.data]);
  const refresh = () => { bal.reload(); if (skip === 0) hist.reload(); else setSkip(0); };
  return (
    <Screen>
      <H1 style={{ marginTop: 8 }}>Rewards</H1>
      <T color={c.mute} weight="600">Points and credits from the venues, academies, coaches and events you play with. Each balance stays with the business that gave it, and pays for that business's bills.</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 14 }}>
        {bal.loading && !bal.data ? <Loading /> : bal.error ? <ErrorBox error={bal.error} onRetry={bal.reload} /> : bal.data.length ? bal.data.map((b) => <BalanceCard key={b.id} b={b} onOpen={() => setOpen(b.id)} />)
          : <Empty emoji="⭐" title="No points yet" sub="Pay for a booking, a fee or a session where a rewards programme runs and your points appear here." />}
      </View>
      <Invite onChange={refresh} />
      <Exchanges onDone={refresh} />
      <Section title="Statement" color={c.sun}>
        {rows.length ? rows.map((e) => (
          <Row key={e.id} title={`${e.label} · ${e.programme_name}`} sub={`${day(e.created_at)}${e.note ? ` · ${e.note}` : ''}${e.expires_at ? ` · expires ${day(e.expires_at)}` : ''}${e.earlier ? ' · earlier statement' : ''}`}
            right={<T weight="800" color={e.delta > 0 ? c.mint : c.ink}>{e.delta > 0 ? '+' : ''}{num(e.delta)}</T>} />
        )) : hist.loading ? <Loading /> : <T size={13} color={c.mute}>Nothing yet.</T>}
        {hist.data?.length >= 25 ? <Btn small title="Show more" color={c.paper} ink={c.ink} onPress={() => setSkip(rows.filter((r) => !r.earlier).length)} style={{ alignSelf: 'flex-start' }} /> : null}
      </Section>
      {open ? <ProgrammeSheet id={open} onClose={() => setOpen(null)} /> : null}
    </Screen>
  );
}

/** At a bill: which of my balances can pay part of it, and how much. target = { id, type, amount, currency, label }. */
export function PointsSheet({ target, onClose, onDone }) {
  const { toast } = useSession();
  const opts = useLoad(() => api.get('/loyalty/options', { purpose_type: target.type ?? 'venue_invoice', purpose_id: target.id }), [target.id]);
  const [pick, setPick] = useState(null);
  const [n, setN] = useState(null);
  const [busy, setBusy] = useState(false);
  const o = pick ?? opts.data?.[0];
  const use = Math.min(n ?? o?.usable_points ?? 0, o?.usable_points ?? 0);
  return (
    <Sheet visible onClose={onClose} title="Pay with points">
      {opts.loading && !opts.data ? <Loading /> : opts.error ? <ErrorBox error={opts.error} onRetry={opts.reload} /> : !o ? (
        <Empty emoji="⭐" title="No points can pay this" sub="Your balances belong to other businesses, or this bill is already covered, or the programme's limit is reached." />
      ) : (
        <View style={{ gap: 10 }}>
          {opts.data.length > 1 ? <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{opts.data.map((x) => <Chip key={x.programme_id} label={x.name} active={x.programme_id === o.programme_id} onPress={() => { setPick(x); setN(null); }} />)}</View> : null}
          <T>You have <T weight="700">{num(o.balance)} points</T> in {o.name}. You can use up to <T weight="700">{num(o.usable_points)}</T> on this bill (the programme allows {pct(o.max_redeem_bp)} of a bill).</T>
          <Counter value={use} min={1} max={Math.max(1, o.usable_points)} step={Math.max(1, Math.min(100, Math.floor(o.usable_points / 10)))} onChange={setN} label="Points to use" />
          <T weight="800" size={18}>Saves {moneyIn(use, o.currency)}</T>
          <T size={12} color={c.mute}>Points you spend earn no new points. If the payment is cancelled they come back as the programme's rules say.</T>
          <Btn title={`Use ${num(use)} points`} loading={busy} disabled={use <= 0} onPress={async () => {
            setBusy(true);
            try {
              const r = await api.post('/loyalty/redeem', { programme_id: o.programme_id, purpose_type: target.type ?? 'venue_invoice', purpose_id: target.id, points: use, request_key: `${target.id}-${use}-${Math.floor(Date.now() / 60000)}` });
              toast(r.paid ? 'Paid with points ✓' : `${r.points_used} points used`); await onDone?.(r); onClose();
            } catch (e) { toast(e.message); } finally { setBusy(false); }
          }} />
        </View>
      )}
    </Sheet>
  );
}

// ---------------------------------------------------------------------------------------------------------- business console
const EVENT_CHOICES = (choices) => choices.events.map((e) => ({ value: e.key, label: e.short }));

function RulesEditor({ prog, onClose, onPublished }) {
  const { toast } = useSession();
  const detail = useLoad(() => api.get(`/loyalty/programmes/${prog.id}/admin`), [prog.id]);
  const [rules, setRules] = useState(null);
  const [sheet, setSheet] = useState(null);
  const d = detail.data;
  React.useEffect(() => { if (d && !rules) setRules(structuredClone(d.rules)); }, [d]);
  if (!d || !rules) return <Sheet visible onClose={onClose} title="Rules"><Loading /></Sheet>;
  const cur = d.currency;
  const set = (patch) => setRules((r) => ({ ...r, ...patch }));
  const publish = async (v) => {
    const out = await api.post(`/loyalty/programmes/${prog.id}/publish`, { rules, ...(v.range?.from ? { starts_on: v.range.from, ends_on: v.range.to } : {}), note: v.note });
    onPublished?.(); onClose(); return `Version ${out.version} is live`;
  };
  return (
    <Sheet visible onClose={onClose} title={`Rules · ${prog.name}`}>
      <T size={13} color={c.mute}>Changes apply from now on. Everything already earned keeps the rules it was earned under.</T>
      <Section title="Earning" color={c.mint}>
        {rules.earn.map((r, i) => (
          <Row key={r.key} title={ruleLine({ ...r, event_label: d.choices.events.find((e) => e.key === r.event)?.short }, cur)} sub={r.member_cap ? `Up to ${r.member_cap.points} per ${r.member_cap.per} each` : undefined}
            right={<Btn small title="Remove" color={c.paper} ink={c.red} onPress={() => set({ earn: rules.earn.filter((_, k) => k !== i) })} />} />
        ))}
        {!rules.earn.length ? <T size={13} color={c.mute}>No earning rule: members can't earn here yet.</T> : null}
        <Btn small title="＋ Add an earning rule" onPress={() => setSheet('earn')} style={{ alignSelf: 'flex-start' }} />
      </Section>
      <Section title="Spending" color={c.sun}>
        <T size={13}>{rules.redeem.purposes.length ? `On ${rules.redeem.purposes.map((p) => d.choices.purposes.find((x) => x.key === p)?.label ?? p).join(', ')}; up to ${pct(rules.redeem.max_redeem_bp)} of a bill; ${rules.redeem.restore_on_cancel === 'full' ? 'returned on cancellation' : 'not returned on cancellation'}.` : 'Not spendable on bills.'}</T>
        <Btn small title="Change spending rules" color={c.violet} onPress={() => setSheet('redeem')} style={{ alignSelf: 'flex-start' }} />
      </Section>
      <Section title="Limits & who can join" color={c.sky}>
        <T size={13}>Points expire after {rules.expiry_months} months{rules.caps.member_points_per_month ? `; up to ${rules.caps.member_points_per_month} a month each` : ''}{rules.caps.programme_points_total ? `; budget ${rules.caps.programme_points_total} points in total` : ''}. {rules.eligibility.youth === 'guardian_linked' ? 'Young people join through a verified guardian.' : 'Not for young people.'}</T>
        <Btn small title="Change limits" color={c.violet} onPress={() => setSheet('limits')} style={{ alignSelf: 'flex-start' }} />
      </Section>
      <Section title="Invites" color={c.pink}>
        <T size={13}>{rules.referral.enabled ? `Referrer ${num(rules.referral.referrer_points)} points, friend ${num(rules.referral.invitee_points)} points, after "${(d.choices.events.find((e) => e.key === rules.referral.qualifying_event)?.short ?? '').toLowerCase()}" and ${rules.referral.holdback_days} days.` : 'Off.'}</T>
        <Btn small title="Change invite reward" color={c.violet} onPress={() => setSheet('referral')} style={{ alignSelf: 'flex-start' }} />
      </Section>
      <Btn title={`Publish version ${(d.current_version ?? 0) + 1}`} onPress={() => setSheet('publish')} style={{ marginTop: 12 }} />

      <FormSheet visible={sheet === 'earn'} onClose={() => setSheet(null)} title="Earning rule" submitLabel="Add rule" initial={{ mode: 'percent', percent: 5, points: 100, event: d.choices.events[0]?.key }}
        fields={[{ key: 'event', label: 'When does a member earn?', type: 'chips', options: EVENT_CHOICES(d.choices) },
          { key: 'mode', label: 'How much?', type: 'chips', options: [{ value: 'percent', label: '% of what they pay' }, { value: 'fixed', label: 'A fixed number of points' }], show: (v) => v.event !== 'sponsored_challenge' },
          { key: 'percent', label: 'Back as points', type: 'stepper', min: 1, max: 50, step: 1, suffix: '%', show: (v) => v.mode === 'percent' && v.event !== 'sponsored_challenge' },
          { key: 'points', label: 'Points each time', type: 'stepper', min: 1, max: 100000, step: 50, show: (v) => v.mode === 'fixed' || v.event === 'sponsored_challenge' },
          { key: 'min_spend', label: 'Smallest payment that counts', type: 'money', currency: cur, optional: true, hint: 'Leave empty for any payment. Bills paid wholly with points never earn.' },
          { key: 'label', label: 'Name it for members', type: 'chips', optional: true, options: ['Booking reward', 'Fee reward', 'Session reward', 'Thanks for playing', 'Challenge'] }]}
        onSubmit={async (v) => {
          const fixed = v.event === 'sponsored_challenge' || v.mode === 'fixed';
          const key = `${v.event.split('_')[0]}_${rules.earn.length + 1}`;
          set({ earn: [...rules.earn, { key, event: v.event, mode: fixed ? 'fixed' : 'percent', ...(fixed ? { points: v.points } : { percent_bp: v.percent * 100 }), min_spend_minor: v.min_spend ?? 0, ...(v.label ? { label: v.label } : {}) }] });
          return 'Rule added — publish to apply';
        }} />
      <FormSheet visible={sheet === 'redeem'} onClose={() => setSheet(null)} title="Spending rules" submitLabel="Save" initial={{ purposes: rules.redeem.purposes, pct: rules.redeem.max_redeem_bp / 100, restore: rules.redeem.restore_on_cancel, expiry: rules.redeem.restore_expiry }}
        fields={[{ key: 'purposes', label: 'Members can spend on', type: 'multi', optional: true, options: d.choices.purposes.map((p) => ({ value: p.key, label: p.label })) },
          { key: 'pct', label: 'Most of one bill points can pay', type: 'stepper', min: 1, max: 100, step: 5, suffix: '%' },
          { key: 'restore', label: 'If a payment is cancelled', type: 'chips', options: [{ value: 'full', label: 'Give points back' }, { value: 'none', label: 'Keep them spent' }] },
          { key: 'expiry', label: 'Points given back expire', type: 'chips', options: [{ value: 'fresh', label: 'A fresh period' }, { value: 'original', label: 'On their original date' }], show: (v) => v.restore === 'full' }]}
        onSubmit={async (v) => { set({ redeem: { ...rules.redeem, purposes: v.purposes ?? [], max_redeem_bp: Math.round(v.pct * 100), restore_on_cancel: v.restore, restore_expiry: v.expiry ?? 'fresh' } }); return 'Saved — publish to apply'; }} />
      <FormSheet visible={sheet === 'limits'} onClose={() => setSheet(null)} title="Limits & eligibility" submitLabel="Save"
        initial={{ expiry: rules.expiry_months, cap_on: !!rules.caps.member_points_per_month, cap: rules.caps.member_points_per_month ?? 5000, budget_on: !!rules.caps.programme_points_total, budget: rules.caps.programme_points_total ?? 100000, youth: rules.eligibility.youth }}
        fields={[{ key: 'expiry', label: 'Points expire after', type: 'stepper', min: 1, max: 60, step: 1, suffix: ' months' },
          { key: 'cap_on', label: 'Limit what one member can earn each month', type: 'switch' },
          { key: 'cap', label: 'Most points per member per month', type: 'stepper', min: 1, max: 10000000, step: 500, show: (v) => v.cap_on },
          { key: 'budget_on', label: 'Set a total budget for the programme', type: 'switch' },
          { key: 'budget', label: 'Most points this programme will ever issue', type: 'stepper', min: 1, max: 100000000, step: 10000, show: (v) => v.budget_on },
          { key: 'youth', label: 'Young people', type: 'chips', options: [{ value: 'excluded', label: 'Not included' }, { value: 'guardian_linked', label: 'Only with a verified guardian' }] }]}
        onSubmit={async (v) => { set({ expiry_months: v.expiry, caps: { ...(v.cap_on ? { member_points_per_month: v.cap } : {}), ...(v.budget_on ? { programme_points_total: v.budget } : {}) }, eligibility: { youth: v.youth } }); return 'Saved — publish to apply'; }} />
      <FormSheet visible={sheet === 'referral'} onClose={() => setSheet(null)} title="Invite reward" submitLabel="Save"
        initial={{ on: rules.referral.enabled, event: rules.referral.qualifying_event ?? d.choices.events[0]?.key, min: rules.referral.min_spend_minor || undefined, a: rules.referral.referrer_points || 200, b: rules.referral.invitee_points || 100, hold: rules.referral.holdback_days }}
        fields={[{ key: 'on', label: 'Reward members who invite friends', type: 'switch' },
          { key: 'event', label: 'The friend must first…', type: 'chips', options: EVENT_CHOICES(d.choices).filter((e) => !['sponsored_challenge', 'membership_tenure'].includes(e.value)), show: (v) => v.on },
          { key: 'min', label: 'Smallest payment that counts', type: 'money', currency: cur, optional: true, show: (v) => v.on },
          { key: 'a', label: 'Points for the inviter', type: 'stepper', min: 0, max: 100000, step: 50, show: (v) => v.on },
          { key: 'b', label: 'Points for the friend', type: 'stepper', min: 0, max: 100000, step: 50, show: (v) => v.on },
          { key: 'hold', label: 'Wait before paying out', type: 'stepper', min: 0, max: 90, step: 1, suffix: ' days', hint: 'A refund inside this time cancels the reward.', show: (v) => v.on }]}
        onSubmit={async (v) => { set({ referral: v.on ? { ...rules.referral, enabled: true, qualifying_event: v.event, min_spend_minor: v.min ?? 0, referrer_points: v.a, invitee_points: v.b, holdback_days: v.hold } : { ...rules.referral, enabled: false } }); return 'Saved — publish to apply'; }} />
      <FormSheet visible={sheet === 'publish'} onClose={() => setSheet(null)} title="Publish these rules" submitLabel="Publish"
        fields={[{ key: 'from', toKey: 'to', label: 'Run as a campaign between (optional)', type: 'daterange', optional: true }, { key: 'note', label: 'What changed?', type: 'chips', optional: true, options: ['New programme', 'Seasonal boost', 'Rates changed', 'New spending rules', 'Housekeeping'] }]}
        onSubmit={async (v) => publish({ range: v.from ? { from: v.from, to: v.to } : null, note: v.note })} />
    </Sheet>
  );
}

function ProgrammeCard({ p, owner, onChange }) {
  const { toast } = useSession();
  const liab = useLoad(() => api.get(`/loyalty/programmes/${p.id}/liability`), [p.id, p.current_version, p.status]);
  const [edit, setEdit] = useState(false);
  const [view, setView] = useState(null);
  const [adj, setAdj] = useState(false);
  const [award, setAward] = useState(false);
  const detail = useLoad(() => (view || award ? api.get(`/loyalty/programmes/${p.id}/admin`) : Promise.resolve(null)), [view, award, p.id]);
  const l = liab.data;
  const [tone, label] = STATUS[p.status] ?? STATUS.draft;
  const act = async (action) => { try { await api.post(`/loyalty/programmes/${p.id}/status`, { action }); toast(action === 'end' ? 'Programme ended' : action === 'pause' ? 'Paused' : 'Running'); onChange(); } catch (e) { toast(e.message); } };
  const challenges = detail.data?.rules?.earn.filter((r) => r.event === 'sponsored_challenge') ?? [];
  return (
    <Card>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}><T weight="800" size={17} style={{ flex: 1 }}>{p.name}</T><Tag label={label} color={tone} /></View>
      <T size={12} color={c.mute}>{p.currency} · {p.funding_owner === 'sponsor' ? 'sponsor-funded' : p.funding_owner === 'platform' ? 'platform-funded' : 'funded by you'}{p.current_version ? ` · version ${p.current_version}` : ' · no rules published yet'}</T>
      {l ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
          <StatPill label="Issued" value={num(l.issued)} /><StatPill label="Spent" value={num(l.redeemed)} /><StatPill label="Expired" value={num(l.expired)} />
          <StatPill label="Owed now" value={`${l.outstanding.members} people · ${moneyIn(l.outstanding.value_minor, p.currency)}`} /><StatPill label="Breakage" value={pct(l.breakage_bp)} />
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
        <Btn small title={p.current_version ? 'Edit rules' : 'Set up rules'} onPress={() => setEdit(true)} />
        {p.status === 'active' ? <Btn small title="Pause" color={c.paper} ink={c.ink} onPress={() => act('pause')} /> : null}
        {p.status === 'paused' ? <Btn small title="Resume" color={c.mint} onPress={() => act('resume')} /> : null}
        {p.current_version && p.status !== 'ended' ? <Btn small title="Give / take points" color={c.violet} onPress={() => setAdj(true)} /> : null}
        {p.current_version ? <Btn small title="Challenge award" color={c.violet} onPress={() => setAward(true)} /> : null}
        <Btn small title="Members" color={c.paper} ink={c.ink} onPress={() => setView('members')} />
        <Btn small title="Invites" color={c.paper} ink={c.ink} onPress={() => setView('referrals')} />
        {p.status !== 'ended' && p.current_version ? <Btn small title="End" color={c.paper} ink={c.red} onPress={() => act('end')} /> : null}
      </View>
      {edit ? <RulesEditor prog={p} onClose={() => setEdit(false)} onPublished={onChange} /> : null}
      {view ? <MembersSheet prog={p} view={view} onClose={() => setView(null)} /> : null}
      <FormSheet visible={adj} onClose={() => setAdj(false)} title="Give or take points" submitLabel="Apply" initial={{ sign: 'give', points: 500 }}
        fields={[{ key: 'person', label: 'Member', type: 'entity', entityKind: 'person', noun: 'member' },
          { key: 'sign', label: 'What?', type: 'chips', options: [{ value: 'give', label: 'Give points' }, { value: 'take', label: 'Take points back' }] },
          { key: 'points', label: 'Points', type: 'stepper', min: 1, max: 1000000, step: 100, hint: `1 point = ${moneyIn(1, p.currency)}` },
          { key: 'reason', label: 'Why (the member sees this)', type: 'chips', options: ['Sorry about the cancelled game', 'Thanks for being a regular', 'Welcome gift', 'Tournament prize', 'Correction'] }]}
        onSubmit={async (v) => { const r = await api.post(`/loyalty/programmes/${p.id}/adjust`, { user_id: v.person, points: v.sign === 'give' ? v.points : -v.points, reason: v.reason }); liab.reload(); return `${SIGN(r.points)} points applied`; }} />
      <FormSheet visible={award && !!challenges.length} onClose={() => setAward(false)} title="Award a challenge" submitLabel="Award"
        fields={[{ key: 'person', label: 'Member', type: 'entity', entityKind: 'person', noun: 'member' },
          { key: 'rule_key', label: 'Challenge', type: 'chips', options: challenges.map((r) => ({ value: r.key, label: r.label ?? r.key })) },
          { key: 'evidence_ref', label: 'Result or evidence reference', hint: 'e.g. the timing sheet or match id you verified. One award per reference.' }]}
        onSubmit={async (v) => { const r = await api.post(`/loyalty/programmes/${p.id}/challenges/award`, { user_id: v.person, rule_key: v.rule_key, evidence_ref: v.evidence_ref }); liab.reload(); return r.awarded ? `${r.points} points awarded` : 'Already awarded for that reference'; }} />
      {award && detail.data && !challenges.length ? <Sheet visible onClose={() => setAward(false)} title="Award a challenge"><Empty emoji="🏅" title="No challenge rule yet" sub="Add an earning rule for a sponsor-funded challenge, publish it, then award it here." /></Sheet> : null}
    </Card>
  );
}

function MembersSheet({ prog, view, onClose }) {
  const { toast } = useSession();
  const members = useLoad(() => (view === 'members' ? api.get(`/loyalty/programmes/${prog.id}/members`, { limit: 50 }) : Promise.resolve([])), [view]);
  const refs = useLoad(() => (view === 'referrals' ? api.get(`/loyalty/programmes/${prog.id}/referrals`, { limit: 50 }) : Promise.resolve([])), [view]);
  const [note, setNote] = useState(null);
  const review = async (r, decision) => { try { await api.post(`/loyalty/referrals/${r.id}/review`, { decision, note: decision === 'approve' ? 'Checked and fine' : 'Looks like the same person' }); toast(decision === 'approve' ? 'Approved' : 'Blocked'); refs.reload(); } catch (e) { toast(e.message); } };
  return (
    <Sheet visible onClose={onClose} title={view === 'members' ? `Members · ${prog.name}` : `Invites · ${prog.name}`}>
      {view === 'members' ? (members.loading ? <Loading /> : members.data.length ? members.data.map((m) => <Row key={m.user_id} title={m.display_name} sub={`@${m.handle} · next expiry ${day(m.next_expiry)}`} right={<T weight="800">{num(m.points)}</T>} />) : <Empty emoji="👥" title="No members yet" sub="People appear here once they hold points in this programme." />)
        : (refs.loading ? <Loading /> : refs.data.length ? refs.data.map((r) => (
          <Card key={r.id} color={r.status === 'held' ? c.sunSoft : c.paper}>
            <T weight="700">@{r.referrer_handle} → @{r.invitee_handle}</T>
            <T size={12} color={c.mute}>{r.status}{r.flags?.length ? ` · ${r.flags.join(', ').replace(/_/g, ' ')}` : ''}{r.campaign ? ` · ${r.campaign}` : ''}</T>
            {r.status === 'held' ? <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}><Btn small title="Approve" color={c.mint} onPress={() => review(r, 'approve')} /><Btn small title="Block" color={c.paper} ink={c.red} onPress={() => review(r, 'reject')} /></View> : null}
          </Card>
        )) : <Empty emoji="🎁" title="No invites yet" sub="Invites to this programme show here, with any that need a person to check them." />)}
    </Sheet>
  );
}

/**
 * The one place a business runs its rewards. Embed it wherever that business is managed:
 * <LoyaltyConsole ownerKind="venue" ownerId={venue.id} currency={venue.currency} />. Platform staff use ownerKind="platform".
 */
export function LoyaltyConsole({ ownerKind, ownerId, currency }) {
  const { toast } = useSession();
  const list = useLoad(() => api.get('/loyalty/programmes', { view: 'mine', owner_kind: ownerKind, ...(ownerId ? { owner_id: ownerId } : {}) }), [ownerKind, ownerId]);
  const spons = useLoad(() => api.get('/loyalty/fundable-sponsorships', { owner_kind: ownerKind, ...(ownerId ? { owner_id: ownerId } : {}) }).catch(() => []), [ownerKind, ownerId]);
  const [create, setCreate] = useState(false);
  const needCurrency = !['venue', 'event'].includes(ownerKind);
  return (
    <Section title="⭐ Rewards & referrals" color={c.sun}>
      <T size={13} color={c.mute}>Reward real activity — completed bookings, paid fees, finished sessions, events played, and friends who join and take part. Every point is in a ledger that is never edited, and each business's points stay its own.</T>
      {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : list.data.length ? list.data.map((p) => <ProgrammeCard key={p.id} p={p} owner={ownerKind} onChange={list.reload} />)
        : <Empty emoji="🎁" title="No rewards programme yet" sub="Start one: choose what earns points and what they can pay for, then publish." />}
      <Btn small title="＋ New programme" onPress={() => setCreate(true)} style={{ alignSelf: 'flex-start' }} />
      <FormSheet visible={create} onClose={() => setCreate(false)} title="New rewards programme" submitLabel="Create draft" initial={{ unit: 'points', funding: 'owner', currency }}
        fields={[{ key: 'name', label: 'Name members will see', hint: 'e.g. "Court Club"' },
          { key: 'unit', label: 'Call them', type: 'chips', options: [{ value: 'points', label: 'Points' }, { value: 'credits', label: 'Credits' }] },
          ...(needCurrency ? [{ key: 'currency', label: 'Currency', type: 'currency' }] : []),
          { key: 'funding', label: 'Who pays for the rewards?', type: 'chips', options: [{ value: 'owner', label: 'We do' }, ...(ownerKind === 'platform' ? [{ value: 'platform', label: 'Gotmygame' }] : []), ...((spons.data ?? []).length ? [{ value: 'sponsor', label: 'A sponsor' }] : [])] },
          { key: 'sponsorship_id', label: 'Sponsorship agreement', type: 'chips', options: (spons.data ?? []).map((s) => ({ value: s.id, label: `${s.sponsor_name} · ${moneyIn(Number(s.amount_cents), s.currency)}` })), show: (v) => v.funding === 'sponsor' }]}
        onSubmit={async (v) => { await api.post('/loyalty/programmes', { owner_kind: ownerKind, ...(ownerId ? { owner_id: ownerId } : {}), name: v.name, unit: v.unit, ...(needCurrency ? { currency: v.currency } : {}), funding_owner: v.funding, ...(v.funding === 'sponsor' ? { sponsorship_id: v.sponsorship_id } : {}) }); list.reload(); return 'Draft created — set up its rules'; }} />
    </Section>
  );
}

/** Standalone host for a business's rewards console (venue, event, platform …): push('RewardsConsole', { ownerKind, ownerId, currency, title }). */
export function RewardsConsole({ ownerKind, ownerId, currency, title }) {
  return (
    <Screen>
      <H1 style={{ marginTop: 8 }}>{title ?? 'Rewards'}</H1>
      <LoyaltyConsole ownerKind={ownerKind} ownerId={ownerId} currency={currency} />
    </Screen>
  );
}
