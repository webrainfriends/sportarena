import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { useSession } from '../session';
import { Btn, Card, Empty, Field, Loading, Sheet, T, Tag } from '../ui';
import { moneyIn } from '../vtime';
import { c } from '../theme';
import { explain, LoadError } from '../access';

// Traceability for budgets: follow the money from a budget down to the payments (BudgetTrace), map programs onto a budget
// (LinkProgramsSheet) and find spending that sits on no budget at all (BudgetCoverage). The server derives every figure.
const day = (iso) => (iso ? new Date(`${String(iso).slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const PAY = { reported: 'reported, not confirmed', confirmed: 'confirmed', reversed: 'reversed' };
const DUE_TONE = { fulfilled: c.limeSoft, cancelled: c.paper, scheduled: c.paper };

const Toggle = ({ open, onPress, children, label }) => (
  <Pressable onPress={onPress} accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={label} style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
    <T size={12} color={c.mute} style={{ width: 14, marginTop: 3 }}>{open ? '▼' : '▶'}</T>
    <View style={{ flex: 1 }}>{children}</View>
  </Pressable>
);

const Totals = ({ t, currency }) => (
  <T size={12} color={c.mute}>
    {[t.reserved_cents ? `${moneyIn(t.reserved_cents, currency)} reserved` : null, `${moneyIn(t.committed_cents, currency)} committed`, `${moneyIn(t.paid_cents, currency)} paid`, t.refunded_cents ? `${moneyIn(t.refunded_cents, currency)} refunded` : null, t.planned_cents ? `${moneyIn(t.planned_cents, currency)} planned` : null].filter(Boolean).join(' · ')}
  </T>
);

function Agreement({ a, currency, open, toggle, mayApprove, onApprove, onReject }) {
  const { push } = useNav();
  return (
    <View style={{ gap: 6, paddingLeft: 6, borderLeftWidth: 2, borderColor: c.line }}>
      <Toggle open={open} onPress={toggle} label={`Agreement ${a.ref ?? ''} ${a.who ?? ''}`}>
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          <T weight="800" size={13} style={{ flex: 1 }}>{a.who ?? 'Agreement'} · {a.ref ?? 'no reference'}</T>
          <Tag label={a.approval === 'pending' ? 'Needs approval' : a.planned ? 'Planned' : a.status} color={c.paper} />
        </View>
        <Totals t={{ committed_cents: a.totals.committed_cents, paid_cents: a.totals.paid_cents, refunded_cents: a.totals.refunded_cents, planned_cents: a.totals.planned_cents }} currency={currency} />
      </Toggle>
      {open ? (
        <View style={{ gap: 6, paddingLeft: 22 }}>
          {a.obligations.length ? a.obligations.map((o) => (
            <View key={o.id} style={{ backgroundColor: DUE_TONE[o.status] ?? c.paper, borderRadius: 10, padding: 10, gap: 3, borderWidth: 1, borderColor: c.line }}>
              <T size={12} weight="800">{day(o.due_on)} · {o.label} · {moneyIn(o.amount_cents, o.currency)} <T size={12} color={c.mute}>({o.status})</T></T>
              {o.payments.length ? o.payments.map((p) => <T key={p.id} size={12} color={c.mute}>↳ {moneyIn(p.amount_cents, p.currency)} · {p.method.replace('_', ' ')} · ref {p.reference} · {day(p.paid_on)} · {PAY[p.status] ?? p.status}</T>) : <T size={12} color={c.mute}>No payment yet</T>}
            </View>
          )) : <T size={12} color={c.mute}>{a.planned ? 'An offer not yet accepted: nothing is committed, no dues exist yet.' : 'No money dues on this agreement.'}</T>}
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            <Btn small title="Open agreement" color={c.paper} ink={c.ink} onPress={() => push('SponsorDeal', { id: a.id })} accessibilityLabel={`Open agreement ${a.ref ?? ''}`} />
            {a.approval === 'pending' && mayApprove ? (
              <>
                <Btn small title="Approve" color={c.mint} ink={c.ink} onPress={() => onApprove(a)} accessibilityLabel="Approve this offer" />
                <Btn small title="Reject" color={c.paper} ink={c.red} onPress={() => onReject(a)} accessibilityLabel="Reject this offer" />
              </>
            ) : null}
          </View>
        </View>
      ) : null}
    </View>
  );
}

function Node({ n, title, tag, currency, open, toggle, isOpen, ...rest }) {
  const { push } = useNav();
  return (
    <Card>
      <Toggle open={open} onPress={toggle} label={title}>
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><T weight="900" style={{ flex: 1 }}>{title}</T>{tag ? <Tag label={tag} color={c.paper} /> : null}</View>
        <Totals t={n.totals} currency={currency} />
      </Toggle>
      {open ? (
        <View style={{ gap: 10, marginTop: 6 }}>
          {n.awards.map((w) => (
            <View key={w.reservation_id} style={{ paddingLeft: 6, borderLeftWidth: 2, borderColor: c.line }}>
              <T size={13} weight="800">Award · {w.who} · {moneyIn(w.budget_amount_cents, currency)} reserved</T>
              <T size={12} color={c.mute}>Held until the recipient answers{w.currency !== currency ? ` · offered ${moneyIn(w.amount_cents, w.currency)}` : ''}</T>
            </View>
          ))}
          {n.agreements.map((a) => <Agreement key={a.id} a={a} currency={currency} open={isOpen(a.id)} toggle={() => rest.flip(a.id)} mayApprove={rest.mayApprove} onApprove={rest.onApprove} onReject={rest.onReject} />)}
          {!n.awards.length && !n.agreements.length ? <T size={12} color={c.mute}>Nothing has been awarded or agreed from this program on this budget yet.</T> : null}
          {n.program ? <Btn small title="Open program" color={c.paper} ink={c.ink} style={{ alignSelf: 'flex-start' }} onPress={() => push('SponsorProgram', { id: n.program.id })} accessibilityLabel={`Open program ${n.program.name}`} /> : null}
        </View>
      ) : null}
    </Card>
  );
}

/** One budget, end to end: programs -> awards and agreements -> scheduled dues -> payments. `tick` changes when the budget is reloaded. */
export function BudgetTrace({ budget: b, tick, mayApprove, onApprove, onReject }) {
  const { push } = useNav();
  const tr = useLoad(() => api.get(`/sponsorship-budgets/${b.id}/trace`), [b.id, tick]);
  const [open, setOpen] = useState({});
  if (tr.error) return <LoadError error={tr.error} onRetry={tr.reload} />;
  if (tr.loading && !tr.data) return <Loading />;
  const t = tr.data;
  const nodes = [...t.programs, ...(t.direct ? [t.direct] : [])];
  const isOpen = (k) => open[k] ?? (k === nodes[0]?.program?.id && nodes.length === 1);
  const flip = (k) => setOpen((o) => ({ ...o, [k]: !isOpen(k) }));
  return (
    <>
      <T size={12} color={t.reconciles ? c.mute : c.red}>{t.reconciles ? '✓ Every figure below adds up to the balances above.' : 'These figures do not add up to the balances above. Refresh; if it persists, report it.'}</T>
      {nodes.length ? nodes.map((n) => (
        <Node key={n.program?.id ?? 'direct'} n={n} title={n.program?.name ?? 'Agreements without a program'} tag={n.program?.status} currency={b.currency} open={isOpen(n.program?.id ?? 'direct')} toggle={() => flip(n.program?.id ?? 'direct')} isOpen={isOpen} flip={flip} mayApprove={mayApprove} onApprove={onApprove} onReject={onReject} />
      )) : <Empty emoji="🧾" title="Nothing draws on this budget yet" sub="Link a program to it, or propose an agreement against it, and every award, due and payment is traced here." />}
      {t.children.length ? (
        <View style={{ gap: 6 }}>
          <T size={12} color={c.mute} weight="700">CHILD BUDGETS</T>
          {t.children.map((k) => (
            <Card key={k.id} pad={12} onPress={() => push('SponsorBudget', { id: k.id })} accessibilityLabel={`${k.name}, ${k.code}. Open budget`}>
              <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><T weight="900" style={{ flex: 1 }}>{k.name}</T><Tag label={k.code} color={c.paper} /></View>
              <T size={12} color={c.mute}>{moneyIn(k.committed_cents, k.currency)} committed · {moneyIn(k.reserved_cents, k.currency)} reserved · {moneyIn(k.paid_cents, k.currency)} paid of {moneyIn(k.authorized_cents, k.currency)}</T>
            </Card>
          ))}
        </View>
      ) : null}
    </>
  );
}

/** Map programs onto one budget (several at once). A program draws on one budget at a time; the server refuses a move that would strand money. */
export function LinkProgramsSheet({ visible, onClose, budget: b, onDone }) {
  const { toast } = useSession();
  const [q, setQ] = useState('');
  const [pick, setPick] = useState([]);
  const [busy, setBusy] = useState(false);
  const [fails, setFails] = useState([]);
  const progs = useLoad(() => (visible ? api.get('/sponsorship-programs', { sponsor_id: b.sponsor_id, limit: 100 }) : Promise.resolve([])), [visible, b.sponsor_id]);
  const buds = useLoad(() => (visible ? api.get('/sponsorship-budgets', { sponsor_id: b.sponsor_id, status: 'active', limit: 100 }).catch(() => []) : Promise.resolve([])), [visible, b.sponsor_id]);
  const named = Object.fromEntries((buds.data ?? []).map((x) => [x.id, x]));
  const cands = (progs.data ?? []).filter((p) => ['draft', 'published'].includes(p.status) && p.budget_id !== b.id && (!q.trim() || p.name.toLowerCase().includes(q.trim().toLowerCase())));
  const blocked = (p) => (p.currency !== b.currency && b.fx_policy !== 'explicit' ? `${p.currency} program: this ${b.currency} budget needs “Only at a sourced rate” and a rate first` : null);
  const toggle = (id) => setPick((x) => (x.includes(id) ? x.filter((y) => y !== id) : [...x, id]));
  const close = () => { setPick([]); setFails([]); setQ(''); onClose(); };
  const run = async () => {
    setBusy(true); setFails([]);
    const bad = [];
    for (const id of pick) {
      const p = (progs.data ?? []).find((x) => x.id === id);
      try { await api.post(`/sponsorship-programs/${id}/budget`, { budget_id: b.id, version: p.row_version }); } catch (e) { bad.push({ id, name: p.name, why: explain(e) }); }
    }
    setBusy(false);
    const ok = pick.length - bad.length;
    if (ok) { toast(`${ok} program${ok === 1 ? '' : 's'} now draw${ok === 1 ? 's' : ''} on ${b.code}`); onDone(); }
    if (bad.length) { setFails(bad); setPick(bad.map((x) => x.id)); progs.reload(); } else close();
  };
  return (
    <Sheet visible={visible} onClose={busy ? () => {} : close} title={`Link programs to ${b.code}`}
      footer={<><View style={{ flex: 1 }} /><Btn title={pick.length ? `Link ${pick.length} program${pick.length === 1 ? '' : 's'}` : 'Choose programs'} onPress={run} disabled={!pick.length} loading={busy} /></>}>
      <T size={12} color={c.mute}>Every award of a linked program reserves from “{b.name}” first, and its agreements and payments are traced here. A program draws on one budget at a time.</T>
      <Field value={q} onChangeText={setQ} placeholder="Search programs" accessibilityLabel="Search programs" />
      {progs.error ? <LoadError error={progs.error} onRetry={progs.reload} /> : progs.loading && !progs.data ? <Loading /> : cands.length ? cands.map((p) => {
        const why = blocked(p), on = pick.includes(p.id), elsewhere = p.budget_id ? named[p.budget_id] : null;
        return (
          <Pressable key={p.id} disabled={!!why} onPress={() => toggle(p.id)} accessibilityRole="checkbox" accessibilityState={{ checked: on, disabled: !!why }} accessibilityLabel={`${p.name}${why ? `. ${why}` : ''}`}
            style={{ flexDirection: 'row', gap: 10, alignItems: 'center', padding: 12, borderRadius: 12, borderWidth: 2, borderColor: on ? c.pink : c.line, backgroundColor: on ? c.pinkSoft : c.paper, opacity: why ? 0.55 : 1 }}>
            <T size={16} color={c.pink} weight="800" style={{ width: 18 }}>{on ? '☑' : '☐'}</T>
            <View style={{ flex: 1 }}>
              <T weight="800">{p.name}</T>
              <T size={12} color={c.mute}>{p.status} · program budget {moneyIn(Number(p.budget_cents), p.currency)}{p.budget_id ? ` · now on ${elsewhere ? `${elsewhere.code} ${elsewhere.name}` : 'another budget'} (moves here)` : ' · not on any budget'}</T>
              {why ? <T size={12} color={c.red}>{why}</T> : null}
            </View>
          </Pressable>
        );
      }) : <Empty emoji="🎯" title="No program to link" sub="Draft and published programs of this brand appear here. Closed and archived programs keep the budget they had." />}
      {fails.map((f) => <T key={f.id} size={12} color={c.red}>{f.name}: {f.why}</T>)}
    </Sheet>
  );
}

/** Spending that sits on no budget: programs with no budget and agreements with neither a program nor a budget. */
export function BudgetCoverage({ sponsorId, may, refreshKey, onLinked }) {
  const { push } = useNav();
  const { toast } = useSession();
  const cov = useLoad(() => api.get('/budget-coverage', { sponsor_id: sponsorId }).catch(() => null), [sponsorId, refreshKey]);
  const buds = useLoad(() => api.get('/sponsorship-budgets', { sponsor_id: sponsorId, status: 'active', limit: 100 }).catch(() => []), [sponsorId, refreshKey]);
  const [choose, setChoose] = useState(null);
  const d = cov.data;
  if (!d) return null;
  const targets = (buds.data ?? []).filter((x) => x.kind !== 'event');
  const link = async (budget) => {
    const p = choose; setChoose(null);
    try { await api.post(`/sponsorship-programs/${p.id}/budget`, { budget_id: budget.id, version: p.row_version }); toast(`${p.name} now draws on ${budget.code}`); cov.reload(); onLinked?.(); } catch (e) { toast(explain(e)); cov.reload(); }
  };
  if (!d.unmapped_programs.length && !d.unmapped_agreements.length) return d.mapped_programs ? <T size={12} color={c.mute}>✓ All {d.mapped_programs} program{d.mapped_programs === 1 ? '' : 's'} draw on a budget; no agreement sits outside one.</T> : null;
  const spend = (s) => s.map((x) => [x.reserved_cents ? `${moneyIn(x.reserved_cents, x.currency)} reserved` : null, x.committed_cents ? `${moneyIn(x.committed_cents, x.currency)} committed` : null, x.paid_cents ? `${moneyIn(x.paid_cents, x.currency)} paid` : null].filter(Boolean).join(' · ')).filter(Boolean).join(' | ') || 'no spend yet';
  return (
    <Card color={c.sunSoft}>
      <T weight="900">Spending not on any budget</T>
      <T size={12} color={c.mute}>Nothing limits or reports this spending against an authorized budget. Link each program to a budget so its awards, agreements and payments are controlled and traceable.</T>
      {d.unmapped_programs.map((p) => (
        <View key={p.id} style={{ gap: 4, paddingTop: 8, borderTopWidth: 1, borderColor: c.line }}>
          <Pressable onPress={() => push('SponsorProgram', { id: p.id })} accessibilityRole="button" accessibilityLabel={`Open program ${p.name}`}><T weight="800">{p.name} <T size={12} color={c.mute}>({p.status})</T></T></Pressable>
          <T size={12} color={c.mute}>{spend(p.spend)}</T>
          {may && ['draft', 'published'].includes(p.status) ? <Btn small title="Link to a budget" color={c.violet} style={{ alignSelf: 'flex-start' }} onPress={() => setChoose(p)} accessibilityLabel={`Link ${p.name} to a budget`} /> : null}
        </View>
      ))}
      {d.unmapped_agreements.length ? (
        <View style={{ gap: 4, paddingTop: 8, borderTopWidth: 1, borderColor: c.line }}>
          <T weight="800">Agreements outside any budget</T>
          {d.unmapped_agreements.map((a) => (
            <Pressable key={`${a.id}-${a.currency}`} onPress={() => push('SponsorDeal', { id: a.id })} accessibilityRole="button" accessibilityLabel={`Open agreement ${a.ref ?? ''}`}>
              <T size={12} color={c.mute}>{a.who ?? 'Agreement'} · {a.ref ?? 'no reference'} · {a.status}{a.currency ? ` · ${moneyIn(a.committed_cents, a.currency)} committed` : ''}</T>
            </Pressable>
          ))}
          <T size={12} color={c.mute}>Choose a budget when you propose an agreement so it draws on one.</T>
        </View>
      ) : null}
      <Sheet visible={!!choose} onClose={() => setChoose(null)} title={choose ? `Link ${choose.name}` : ''}>
        <T size={12} color={c.mute}>Pick the budget this program’s awards will draw on.</T>
        {targets.length ? targets.map((x) => (
          <Card key={x.id} pad={12} onPress={() => link(x)} accessibilityLabel={`${x.name}, ${x.code}, ${moneyIn(x.available_cents, x.currency)} available. Link here`}>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><T weight="900" style={{ flex: 1 }}>{x.name}</T><Tag label={x.code} color={c.paper} /></View>
            <T size={12} color={c.mute}>{moneyIn(x.available_cents, x.currency)} available of {moneyIn(x.authorized_cents, x.currency)}</T>
          </Card>
        )) : <Empty emoji="🧮" title="No budget to link to" sub="Authorize a year, program or department budget first." />}
      </Sheet>
    </Card>
  );
}
