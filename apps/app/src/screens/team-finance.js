// Team dues, fees, shared expenses and fundraising (#516): the money side of the team workspace, in one place.
// Members see what they owe and the open fundraisers; owners, managers and the organisation's finance staff also get the ledger and the tools.
// Everything is decided by the API (team-money capabilities); this screen only shows it. It never reads player rates or payouts - those stay in "Rates".
import React, { useRef, useState } from 'react';
import { Switch, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, ErrorBox, Field, H1, Loading, Row, Screen, Section, Sheet, StatPill, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { Counter, DateField } from '../pickers';
import { EntityPicker } from '../entity-picker';
import { PaySheet } from '../PaySheet';
import { moneyIn } from '../vtime';
import { c, day, when } from '../theme';

const KIND = { dues: 'Dues', season_fee: 'Season fee', match_fee: 'Match fee', expense: 'Shared expense' };
const STATUS = { awaiting_payment: ['Due', c.sunSoft], paid: ['Paid', c.mintSoft], waived: ['Waived', c.violetSoft], cancelled: ['Cancelled', c.violetSoft] };
const METHODS = [{ value: 'upi', label: 'UPI' }, { value: 'cash', label: 'Cash' }, { value: 'bank', label: 'Bank transfer' }, { value: 'card', label: 'Card' }, { value: 'other', label: 'Other' }];
const newKey = () => `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const Bar = ({ pct, color = c.mint }) => <View style={{ height: 8, borderRadius: 4, backgroundColor: c.line, overflow: 'hidden' }}><View style={{ height: 8, width: `${Math.min(100, pct)}%`, backgroundColor: color }} /></View>;
const ChargeTag = ({ ch }) => <Tag label={ch.overdue ? 'Overdue' : STATUS[ch.status]?.[0] ?? ch.status} color={ch.overdue ? c.redSoft : STATUS[ch.status]?.[1]} />;

export function TeamFinance({ t, w }) {
  const { toast, user } = useSession();
  const fin = useLoad(() => api.get(`/teams/${t.id}/my-finance`), [t.id]);
  const manage = !!fin.data?.can_manage;
  const ledger = useLoad(() => (manage ? api.get(`/teams/${t.id}/ledger`) : Promise.resolve(null)), [t.id, manage]);
  const open = useLoad(() => (manage ? api.get(`/teams/${t.id}/charges`, { status: 'awaiting_payment', limit: 50 }) : Promise.resolve([])), [t.id, manage]);
  const plans = useLoad(() => (manage ? api.get(`/teams/${t.id}/dues-plans`) : Promise.resolve([])), [t.id, manage]);
  const [pay, setPay] = useState(null);
  const [charge, setCharge] = useState(null);      // a charge opened by a manager
  const [sheet, setSheet] = useState(null);        // raise | expense | plan | fund | give
  const key = useRef(newKey());
  const cur = t.currency ?? fin.data?.currency ?? 'INR';
  const reload = () => { fin.reload(); ledger.reload(); open.reload(); plans.reload(); };
  const start = (name) => { key.current = newKey(); setSheet(name); };   // a fresh key per opened form: a retry of the same form never raises twice
  if (fin.error) return <ErrorBox error={fin.error} onRetry={fin.reload} />;
  if (!fin.data) return <Loading />;
  const f = fin.data, L = ledger.data;
  const people = t.members.map((m) => ({ id: m.id, label: m.display_name, sub: m.handle ? `@${m.handle}` : '', emoji: m.avatar_emoji, color: m.avatar_color }));
  const schedule = [
    ...(w?.schedule?.events ?? []).map((e) => ({ value: `e:${e.event_id}`, label: `🏆 ${e.name}` })),
    ...(w?.schedule?.fixtures ?? []).map((x) => ({ value: `f:${x.fixture_id}`, label: `⚽ ${x.home_name ?? 'TBC'} vs ${x.away_name ?? 'TBC'} · ${when(x.scheduled_at)}` })),
  ];
  const scopeOf = (v) => { if (!v.scope) return {}; const [k, ref] = String(v.scope).split(':'); return { [k === 'f' ? 'fixture_id' : 'event_id']: ref }; };

  return (
    <View style={{ width: '100%', maxWidth: 900, alignSelf: 'center', marginTop: 12 }}>
      <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
        <StatPill value={moneyIn(f.owed_minor, cur)} label="You owe" color={f.owed_minor ? c.sunSoft : c.paper} />
        {f.totals ? <StatPill value={`${Math.round((Number(f.totals.collected_minor) * 100) / Math.max(1, Number(f.totals.due_minor)))}%`} label="Team collected" /> : null}
        {f.totals ? <StatPill value={String(f.totals.members_open)} label="Members still to pay" /> : null}
      </View>

      <Section title="What you owe">
        {f.charges.length ? f.charges.map((ch) => (
          <Row key={ch.charge_id} title={ch.title} sub={`${KIND[ch.kind]}${ch.for_member ? ` · for ${ch.for_member}` : ''}${ch.due_on ? ` · due ${day(ch.due_on)}` : ''}${ch.settled_minor ? ` · paid ${moneyIn(ch.settled_minor, ch.currency)}` : ''}`}
            right={<View style={{ alignItems: 'flex-end', gap: 6 }}><T weight="800">{moneyIn(ch.status === 'awaiting_payment' ? ch.balance_minor : ch.amount_minor, ch.currency)}</T><ChargeTag ch={ch} />{ch.purpose ? <Btn small title="Pay" onPress={() => setPay({ type: 'team_charge', id: ch.charge_id, label: ch.title, amount: ch.balance_minor, currency: ch.currency })} accessibilityLabel={`Pay ${ch.title}`} /> : null}</View>} />
        )) : <Empty emoji="🎉" title="Nothing to pay" sub="Dues, fees and your share of team expenses appear here." />}
      </Section>

      <Section title="Fundraising" action={manage ? 'New fundraiser' : undefined} onAction={() => start('fund')}>
        {f.fundraisers.length ? f.fundraisers.map((fr) => (
          <Card key={fr.fundraiser_id}>
            <View style={{ gap: 8 }}>
              <T weight="800">{fr.title}</T><T size={13} color={c.mute}>{fr.purpose}</T>
              <Bar pct={fr.percent} />
              <T size={13}><T weight="800" size={13}>{moneyIn(fr.raised_minor, fr.currency)}</T> of {moneyIn(fr.target_minor, fr.currency)} · {fr.contributors} gave{fr.closes_on ? ` · closes ${day(fr.closes_on)}` : ''}</T>
              <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                {f.can_give ? <Btn small title="Give" onPress={() => { key.current = newKey(); setSheet({ give: fr }); }} accessibilityLabel={`Give to ${fr.title}`} /> : null}
                {manage ? <Btn small title="Close" color={c.paper} ink={c.ink} onPress={async () => { try { await api.post(`/teams/${t.id}/fundraisers/${fr.fundraiser_id}/decision`, { action: 'close' }); reload(); } catch (e) { toast(e.message); } }} /> : null}
              </View>
            </View>
          </Card>
        )) : <Empty emoji="🎯" title="No fundraiser right now" sub={manage ? 'Start one with a target and a purpose.' : 'When the team raises money for something, it shows here.'} />}
        {manage && L?.fundraisers.filter((x) => x.status === 'draft').map((fr) => (
          <Row key={fr.fundraiser_id} title={`${fr.title} · waiting for the owner`} sub={fr.purpose} right={t.owner_id === user?.id ? <Btn small title="Approve" onPress={async () => { try { await api.post(`/teams/${t.id}/fundraisers/${fr.fundraiser_id}/decision`, { action: 'approve' }); reload(); } catch (e) { toast(e.message); } }} /> : null} />
        ))}
      </Section>

      {manage ? (
        <>
          <Section title="Raise money from members">
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              <Btn small title="＋ Dues or fee" onPress={() => start('raise')} />
              <Btn small title="÷ Split an expense" color={c.paper} ink={c.ink} onPress={() => start('expense')} />
              <Btn small title="↻ Recurring dues" color={c.paper} ink={c.ink} onPress={() => start('plan')} />
            </View>
            {plans.data?.length ? plans.data.map((p) => (
              <Row key={p.plan_id} title={`${p.title} · ${moneyIn(p.amount_minor, p.currency)}`} sub={`Every ${p.every_months === 1 ? 'month' : `${p.every_months} months`} · next ${day(p.next_on)} · ${p.status}`}
                right={p.status !== 'ended' ? <Btn small title={p.status === 'active' ? 'Pause' : 'Resume'} color={c.paper} ink={c.ink} onPress={async () => { try { await api.patch(`/team-dues-plans/${p.plan_id}`, { status: p.status === 'active' ? 'paused' : 'active' }); plans.reload(); } catch (e) { toast(e.message); } }} /> : null} />
            )) : null}
          </Section>

          <Section title="Ledger">
            {L ? (
              <>
                <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
                  {L.by_kind.map((k) => <StatPill key={k.kind} value={moneyIn(k.outstanding_minor, L.currency)} label={`${KIND[k.kind]} still due`} />)}
                </View>
                <Card color={L.reconciliation.ok ? c.mintSoft : c.sunSoft}>
                  <T weight="800">{L.reconciliation.ok ? '✓ Reconciled' : '⚠ Needs a look'}</T>
                  <T size={13}>Online {moneyIn(L.reconciliation.online_received_minor, L.currency)} · recorded by hand {moneyIn(L.reconciliation.offline_received_minor, L.currency)}</T>
                  {Number(L.reconciliation.online_refunded_minor) ? <T size={13} color={c.red}>{moneyIn(L.reconciliation.online_refunded_minor, L.currency)} was refunded online — review the charges it paid.</T> : null}
                </Card>
                {L.expenses_owed_back.map((e) => <Row key={e.batch_id} title={`${e.paid_by_name} is owed back for ${e.title}`} sub={`Collected from others ${moneyIn(e.collected_from_others_minor, L.currency)} · still to collect ${moneyIn(e.still_to_collect_minor, L.currency)}`} />)}
              </>
            ) : <Loading />}
            <T weight="800" style={{ marginTop: 6 }}>Open charges</T>
            {open.data?.length ? open.data.map((ch) => (
              <Row key={ch.charge_id} title={`${ch.member_name} · ${ch.title}`} sub={`${KIND[ch.kind]} · ${ch.due_on ? `due ${day(ch.due_on)}` : 'no due date'}${ch.payer_id !== ch.member_id ? ` · paid by ${ch.payer_name}` : ''}`}
                right={<View style={{ alignItems: 'flex-end', gap: 4 }}><T weight="800">{moneyIn(ch.balance_minor, ch.currency)}</T><ChargeTag ch={ch} /></View>} onPress={() => setCharge(ch)} />
            )) : <T color={c.mute}>No open charges.</T>}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 6 }}>
              <View style={{ flex: 1 }}><T weight="700">Members can see team totals</T><T size={12} color={c.mute}>Off: each member sees only their own dues. On: they also see how much the team has collected — never names or other balances.</T></View>
              <Switch accessibilityLabel="Members can see team totals" value={!!L?.members_see_totals} trackColor={{ true: c.pink }} onValueChange={async (x) => { try { await api.patch(`/teams/${t.id}/finance-settings`, { members_see_totals: x }); ledger.reload(); } catch (e) { toast(e.message); } }} />
            </View>
          </Section>
        </>
      ) : null}

      {pay ? <PaySheet target={pay} onClose={() => setPay(null)} onDone={reload} /> : null}
      {charge ? <ChargeSheet charge={charge} onClose={() => setCharge(null)} onChanged={() => { setCharge(null); reload(); }} /> : null}

      <FormSheet visible={sheet === 'raise'} onClose={() => setSheet(null)} title="Raise dues or a fee" submitLabel="Charge members"
        initial={{ kind: 'dues', audience: 'all_active' }}
        fields={[
          { key: 'kind', label: 'What is it?', type: 'chips', options: [{ value: 'dues', label: 'Dues' }, { value: 'season_fee', label: 'Season fee' }, { value: 'match_fee', label: 'Match fee' }] },
          { key: 'title', label: 'Name', hint: 'Shown to everyone charged, e.g. “Season 2026”.' },
          { key: 'amount_minor', label: 'Amount each', type: 'money', currency: cur },
          { key: 'due_on', label: 'Due date', type: 'date', optional: true },
          { key: 'audience', label: 'Who pays?', type: 'chips', options: (v) => [{ value: 'all_active', label: 'Everyone on the roster' }, ...(v.kind === 'match_fee' || schedule.length ? [{ value: 'selected_squad', label: 'The selected squad' }, { value: 'rsvp_going', label: 'Those who said going' }] : []), { value: 'members', label: 'Pick people' }] },
          { key: 'scope', label: 'Event or match', type: 'chips', options: schedule, show: (v) => v.kind === 'match_fee' || v.audience === 'selected_squad' || v.audience === 'rsvp_going', hint: 'A match fee is for one event or match.' },
          { key: 'member_ids', label: 'Members', type: 'multi', options: people.map((p) => ({ value: p.id, label: p.label })), show: (v) => v.audience === 'members' },
        ]}
        onSubmit={async (v) => {
          const r = await api.post(`/teams/${t.id}/charges`, { kind: v.kind, title: v.title, amount_minor: v.amount_minor, due_on: v.due_on, audience: v.audience, member_ids: v.member_ids, include_staff: false, idempotency_key: key.current, ...scopeOf(v) });
          reload();
          return `${r.charges_raised} charged${r.skipped?.length ? ` · ${r.skipped.length} young player${r.skipped.length === 1 ? '' : 's'} skipped until a guardian is verified` : ''}`;
        }} />

      <FormSheet visible={sheet === 'plan'} onClose={() => setSheet(null)} title="Recurring dues" submitLabel="Start dues"
        initial={{ every_months: 1, due_days: 7 }}
        fields={[
          { key: 'title', label: 'Name', hint: 'e.g. Monthly dues' },
          { key: 'amount_minor', label: 'Amount each', type: 'money', currency: cur },
          { key: 'every_months', label: 'Every', type: 'chips', options: [{ value: 1, label: 'Month' }, { value: 3, label: '3 months' }, { value: 6, label: '6 months' }, { value: 12, label: 'Year' }] },
          { key: 'starts_on', label: 'First charge on', type: 'date' },
          { key: 'due_days', label: 'Days to pay', type: 'stepper', min: 0, max: 60, suffix: ' days' },
          { key: 'ends_on', label: 'Last charge on', type: 'date', optional: true },
        ]}
        onSubmit={async (v) => { await api.post(`/teams/${t.id}/dues-plans`, { title: v.title, amount_minor: v.amount_minor, every_months: v.every_months, starts_on: v.starts_on, due_days: v.due_days, ends_on: v.ends_on }); reload(); return 'Recurring dues started'; }} />

      <FormSheet visible={sheet === 'fund'} onClose={() => setSheet(null)} title="New fundraiser" submitLabel="Create"
        fields={[
          { key: 'title', label: 'Name' },
          { key: 'purpose', label: 'What the money is for', type: 'multiline', hint: 'The team owner approves this purpose before anyone can give.' },
          { key: 'target_minor', label: 'Target', type: 'money', currency: cur },
          { key: 'closes_on', label: 'Closes', type: 'date', optional: true },
        ]}
        onSubmit={async (v) => { const r = await api.post(`/teams/${t.id}/fundraisers`, v); reload(); return r.status === 'active' ? 'Fundraiser is open' : 'Sent to the team owner to approve'; }} />

      <FormSheet visible={!!sheet?.give} onClose={() => setSheet(null)} title={`Give to ${sheet?.give?.title ?? ''}`} submitLabel="Continue to payment"
        initial={{ anonymous: false }}
        fields={[
          { key: 'amount_minor', label: 'Amount', type: 'money', currency: sheet?.give?.currency ?? cur },
          { key: 'anonymous', label: 'Hide my name from other members', type: 'switch' },
        ]}
        onSubmit={async (v) => {
          const g = await api.post(`/teams/${t.id}/fundraisers/${sheet.give.fundraiser_id}/contributions`, { amount_minor: v.amount_minor, anonymous: !!v.anonymous, idempotency_key: key.current });
          setTimeout(() => setPay({ type: 'team_contribution', id: g.contribution_id, label: `Gift: ${sheet.give.title}`, amount: g.amount_minor, currency: g.currency }), 300);
        }} />

      {sheet === 'expense' ? <ExpenseSheet t={t} cur={cur} people={people} idKey={key.current} onClose={() => setSheet(null)} onDone={reload} /> : null}
    </View>
  );
}

/** One charge, from the manager's side: record money received outside the app, reduce or waive it, or cancel it. */
function ChargeSheet({ charge, onClose, onChanged }) {
  const { toast } = useSession();
  const d = useLoad(() => api.get(`/team-charges/${charge.charge_id}`), [charge.charge_id]);
  const [form, setForm] = useState(null);   // receive | reduce | waive | cancel
  const key = useRef(newKey());
  const run = async (fn, msg) => { try { await fn(); toast(msg); onChanged(); } catch (e) { toast(e.message); } };
  return (
    <Sheet visible onClose={onClose} title={charge.title}>
      <T>{charge.member_name}{charge.payer_id !== charge.member_id ? ` (paid by ${charge.payer_name})` : ''} · {moneyIn(charge.balance_minor, charge.currency)} of {moneyIn(charge.amount_minor, charge.currency)} still due</T>
      {d.data ? d.data.entries.map((e) => <T key={e.id} size={13} color={c.mute}>{when(e.created_at)} · {e.kind}{e.amount_minor ? ` ${moneyIn(e.amount_minor, charge.currency)}` : ''}{e.method ? ` · ${e.method}` : ''}{e.note ? ` · “${e.note}”` : ''}</T>) : <Loading />}
      <View style={{ gap: 8 }}>
        <Btn title="Record money received" onPress={() => { key.current = newKey(); setForm('receive'); }} />
        <Btn title="Reduce the amount" color={c.paper} ink={c.ink} onPress={() => { key.current = newKey(); setForm('reduce'); }} />
        <Btn title="Waive what is left" color={c.paper} ink={c.ink} onPress={() => { key.current = newKey(); setForm('waive'); }} />
        {Number(charge.settled_minor) === 0 ? <Btn title="Cancel this charge" color={c.red} onPress={() => setForm('cancel')} /> : null}
      </View>
      <FormSheet visible={form === 'receive'} onClose={() => setForm(null)} title="Money received" submitLabel="Record"
        initial={{ method: 'upi', amount_minor: charge.balance_minor }}
        fields={[{ key: 'amount_minor', label: 'Amount', type: 'money', currency: charge.currency }, { key: 'method', label: 'How', type: 'chips', options: METHODS }, { key: 'note', label: 'Reference', optional: true, hint: 'e.g. the UPI transaction id. Stored encrypted.' }]}
        onSubmit={async (v) => { await api.post(`/team-charges/${charge.charge_id}/payments`, { ...v, idempotency_key: key.current }); onChanged(); return 'Recorded'; }} />
      <FormSheet visible={form === 'reduce'} onClose={() => setForm(null)} title="Reduce the amount" submitLabel="Reduce"
        fields={[{ key: 'amount_minor', label: 'Take off', type: 'money', currency: charge.currency }, { key: 'reason', label: 'Why', hint: 'Kept with the charge. Stored encrypted.' }]}
        onSubmit={async (v) => { await api.post(`/team-charges/${charge.charge_id}/adjustments`, { kind: 'reduction', ...v, idempotency_key: key.current }); onChanged(); return 'Reduced'; }} />
      <FormSheet visible={form === 'waive'} onClose={() => setForm(null)} title="Waive what is left" submitLabel="Waive"
        fields={[{ key: 'reason', label: 'Why', hint: 'Kept with the charge. Stored encrypted.' }]}
        onSubmit={async (v) => { await api.post(`/team-charges/${charge.charge_id}/adjustments`, { kind: 'waiver', reason: v.reason, idempotency_key: key.current }); onChanged(); return 'Waived'; }} />
      <FormSheet visible={form === 'cancel'} onClose={() => setForm(null)} title="Cancel this charge" submitLabel="Cancel charge" color={c.red}
        fields={[{ key: 'reason', label: 'Why' }]}
        onSubmit={async (v) => { await api.post(`/team-charges/${charge.charge_id}/cancel`, v); onChanged(); return 'Cancelled'; }} />
    </Sheet>
  );
}

/** Record a team expense and split it: equally, by weight, or by exact shares. The server rounds to the paise and makes the shares add up. */
function ExpenseSheet({ t, cur, people, idKey, onClose, onDone }) {
  const { toast } = useSession();
  const [title, setTitle] = useState('');
  const [total, setTotal] = useState('');
  const [split, setSplit] = useState('equal');
  const [on, setOn] = useState({});            // user id -> included
  const [weight, setWeight] = useState({});
  const [amount, setAmount] = useState({});
  const [paidBy, setPaidBy] = useState([]);
  const [due, setDue] = useState(null);
  const [busy, setBusy] = useState(false);
  const digits = (() => { try { return new Intl.NumberFormat('en', { style: 'currency', currency: cur }).resolvedOptions().maximumFractionDigits; } catch { return 2; } })();
  const toMinor = (x) => Math.round(Number(String(x ?? '').replace(/,/g, '')) * 10 ** digits);
  const chosen = people.filter((p) => on[p.id]);
  const totalMinor = toMinor(total);
  const exactSum = chosen.reduce((s, p) => s + toMinor(amount[p.id]), 0);
  const ok = title.trim() && totalMinor > 0 && chosen.length && (split !== 'exact' || exactSum === totalMinor);
  const save = async () => {
    setBusy(true);
    try {
      const r = await api.post(`/teams/${t.id}/expenses`, {
        title: title.trim(), total_minor: totalMinor, split, paid_by: paidBy[0]?.id, due_on: due ?? undefined, idempotency_key: idKey,
        participants: chosen.map((p) => ({ user_id: p.id, weight: split === 'weights' ? weight[p.id] ?? 1 : undefined, amount_minor: split === 'exact' ? toMinor(amount[p.id]) : undefined })),
      });
      toast(`Split between ${r.charges_raised} members`); onDone(); onClose();
    } catch (e) { toast(e.message); } finally { setBusy(false); }
  };
  return (
    <Sheet visible onClose={onClose} title="Split an expense" footer={<Btn title="Save and tell members" onPress={save} loading={busy} disabled={!ok} />}>
      <Field label="What was it for?" value={title} onChangeText={setTitle} placeholder="Pitch hire, kit, tea…" />
      <Field label={`Total (${cur})`} value={total} onChangeText={(x) => setTotal(x.replace(/[^0-9.,]/g, ''))} keyboardType="decimal-pad" placeholder="0" />
      <EntityPicker label="Who paid up front" optional options={people} value={paidBy} onChange={setPaidBy} noun="member" />
      <T weight="800" size={13}>How to split</T>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        {[['equal', 'Equally'], ['weights', 'By share'], ['exact', 'Exact amounts']].map(([k, l]) => <Chip key={k} label={l} active={split === k} onPress={() => setSplit(k)} />)}
      </View>
      <T weight="800" size={13}>Who shares it ({chosen.length})</T>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Chip label="Everyone" onPress={() => setOn(Object.fromEntries(people.map((p) => [p.id, true])))} /><Chip label="Nobody" onPress={() => setOn({})} />
      </View>
      {people.map((p) => (
        <View key={p.id} style={{ gap: 6 }}>
          <Chip label={`${on[p.id] ? '✓ ' : ''}${p.label}`} active={!!on[p.id]} onPress={() => setOn({ ...on, [p.id]: !on[p.id] })} />
          {on[p.id] && split === 'weights' ? <Counter value={weight[p.id] ?? 1} min={1} max={20} label={`${p.label}'s share`} onChange={(x) => setWeight({ ...weight, [p.id]: x })} /> : null}
          {on[p.id] && split === 'exact' ? <Field label={`${p.label}'s amount`} value={amount[p.id] ?? ''} onChangeText={(x) => setAmount({ ...amount, [p.id]: x.replace(/[^0-9.,]/g, '') })} keyboardType="decimal-pad" /> : null}
        </View>
      ))}
      {split === 'exact' ? <T color={exactSum === totalMinor ? c.mint : c.red} weight="700">Shares add up to {moneyIn(exactSum, cur)} of {moneyIn(totalMinor, cur)}</T> : <T size={12} color={c.mute}>Shares are rounded to the smallest coin the same way every time, and always add up to the total.</T>}
      <DateField label="Pay by" value={due} onChange={setDue} optional />
    </Sheet>
  );
}

/** The money side of a team on its own page: for guardians (who are not on the team and so have no workspace) and for notification links. */
export function TeamDues({ id }) {
  const team = useLoad(() => api.get(`/teams/${id}`), [id]);
  if (team.error) return <Screen><ErrorBox error={team.error} onRetry={team.reload} /></Screen>;
  if (!team.data) return <Screen><Loading /></Screen>;
  return (
    <Screen>
      <H1 style={{ marginTop: 8 }}>{team.data.emoji} {team.data.name}</H1>
      <T color={c.mute} weight="700">Dues & funds</T>
      <TeamFinance t={team.data} w={null} />
    </Screen>
  );
}
