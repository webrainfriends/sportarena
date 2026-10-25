// Beneficiary portfolio (#292): everyone a sponsor supports (or, for a recipient, every sponsor behind what they own), with funding, risk and next actions.
// Read-only: acting happens in the agreement and program screens, so there is no second workflow. The server decides what each person may see.
import React, { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, Field, H1, Loading, Screen, Section, Seg, T, Tag } from '../ui';
import { c } from '../theme';
import { explain, LoadError } from '../access';

// Amounts are minor units of THEIR OWN currency; currencies are never added together.
const fmt = (cents, cur) => { try { const f = new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }); return f.format(cents / 10 ** f.resolvedOptions().maximumFractionDigits); } catch { return `${cents} ${cur ?? ''}`; } };
const when = (iso) => (iso ? new Date(`${String(iso).slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const PAGE = 20;
const KIND = { athlete: 'Athlete', team: 'Team', event: 'Event' };
const STAGE = { active: ['Active', c.lime], pending: ['Pending', c.sunSoft], closed: ['History', c.paper] };
const STAGES = [{ value: null, label: 'All' }, { value: 'active', label: 'Active' }, { value: 'pending', label: 'Pending' }, { value: 'closed', label: 'History' }];
const RISK_TONE = { overdue_payment: c.pinkSoft, overdue_delivery: c.pinkSoft, payment_blocked: c.pinkSoft, unconfirmed_payment: c.sunSoft, agreement_ending: c.sunSoft, review_overdue: c.sunSoft, funding_gap: c.sunSoft, youth_beneficiary: c.violetSoft };
const SHORT = { overdue_payment: 'Payment overdue', overdue_delivery: 'Delivery overdue', payment_blocked: 'Condition open', unconfirmed_payment: 'Unconfirmed', agreement_ending: 'Ending soon', review_overdue: 'Review overdue', funding_gap: 'Funding gap', youth_beneficiary: 'Youth' };

/** A persistent notice. Role "alert" so assistive technology announces it. */
const Banner = ({ tone = c.sunSoft, children, action, onAction }) => (
  <View accessibilityRole="alert" style={{ backgroundColor: tone, borderRadius: 12, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
    <T size={13} style={{ flex: 1 }}>{children}</T>
    {action ? <Btn small title={action} color={c.paper} ink={c.ink} onPress={onAction} /> : null}
  </View>
);

/** One currency block. Requested, awarded and offered are kept apart, and money received is only what was confirmed. */
function Money({ m, dense }) {
  const cells = [
    ['Requested', m.requested_cents], ['Awarded', m.awarded_cents], ['Offered, not accepted', m.offered_cents], ['Still unfunded', m.gap_cents],
    ['Committed', m.committed_cents], ['Received (confirmed)', m.confirmed_cents], ['Reported, unconfirmed', m.reported_unconfirmed_cents], ['Outstanding', m.outstanding_cents],
  ].filter(([, v]) => !dense || v > 0);
  return (
    <View accessible accessibilityLabel={`${m.currency}: ${cells.map(([l, v]) => `${l} ${fmt(v, m.currency)}`).join(', ')}`} style={{ gap: 6 }}>
      <T size={12} weight="800" color={c.mute}>{m.currency}</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 18, rowGap: 6 }}>
        {cells.map(([l, v]) => (
          <View key={l} style={{ minWidth: 110 }}>
            <T size={11} color={c.mute}>{l}</T>
            <T size={14} weight="800" color={l === 'Still unfunded' && v > 0 ? c.pink : c.ink}>{fmt(v, m.currency)}</T>
          </View>))}
      </View>
    </View>
  );
}

const Risks = ({ codes }) => (codes.length ? (
  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{codes.map((r) => <Tag key={r} label={SHORT[r] ?? r} color={RISK_TONE[r] ?? c.sunSoft} />)}</View>) : null);

export function SponsorPortfolio() {
  const { push } = useNav();
  const [view, setView] = useState(null);
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [stage, setStage] = useState(null);
  const [risk, setRisk] = useState(null);
  const [gap, setGap] = useState(false);
  const [offset, setOffset] = useState(0);
  const [exporting, setExporting] = useState(false);
  const { toast } = useSession();
  const timer = useRef();
  useEffect(() => { clearTimeout(timer.current); timer.current = setTimeout(() => { setQ(text.trim()); setOffset(0); }, 350); return () => clearTimeout(timer.current); }, [text]);
  const filters = { ...(view ? { view } : {}), ...(q ? { q } : {}), ...(stage ? { stage } : {}), ...(risk ? { risk } : {}), ...(gap ? { has_gap: true } : {}) };
  const list = useLoad(() => api.get('/beneficiary-portfolio', { ...filters, limit: PAGE, offset }), [view, q, stage, risk, gap, offset]);
  const d = list.data;
  const filtered = !!(q || stage || risk || gap);
  const reset = () => { setText(''); setQ(''); setStage(null); setRisk(null); setGap(false); setOffset(0); };
  const open = (it) => push('PortfolioEntry', { target_type: it.target_type, target_id: it.target_id, view: d.view });
  const exportCsv = async () => {
    setExporting(true);
    try {
      const out = await api.get('/beneficiary-portfolio-export', filters);
      if (typeof document !== 'undefined') { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([out.csv], { type: 'text/csv' })); a.download = out.filename; a.click(); toast(`Exported ${out.rows} rows`); } else toast(`${out.rows} rows ready — open this on the web to download`);
    } catch (e) { toast(explain(e)); } finally { setExporting(false); }
  };

  if (list.error && !d) return <Screen><H1>Beneficiary portfolio</H1><LoadError error={list.error} onRetry={list.reload} /></Screen>;
  return (
    <Screen refreshing={list.loading && !!d} onRefresh={list.reload}>
      <H1>Beneficiary portfolio</H1>
      <T size={13} color={c.mute} accessibilityRole="text">{d?.view === 'recipient' ? 'The sponsors behind the events, teams and profile you own. You see your own agreements only.' : 'Everyone your brands support — across programs, applications, awards and agreements. Other sponsors’ terms are never shown.'}</T>
      {d?.available_views.sponsor && d?.available_views.recipient ? (
        <Seg options={[{ value: 'sponsor', label: 'As a sponsor' }, { value: 'recipient', label: 'As a recipient' }]} value={d.view} onChange={(v) => { setView(v); setOffset(0); }} />) : null}
      <Field value={text} onChangeText={setText} placeholder="Search by name…" accessibilityLabel="Search beneficiaries by name" />
      <Seg options={STAGES} value={stage} onChange={(v) => { setStage(v); setOffset(0); }} />
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <Chip label="Funding gap" active={gap} onPress={() => { setGap(!gap); setOffset(0); }} />
        {Object.entries(d?.risk_labels ?? {}).filter(([k]) => k !== 'funding_gap').map(([k]) => <Chip key={k} label={SHORT[k]} active={risk === k} onPress={() => { setRisk(risk === k ? null : k); setOffset(0); }} />)}
      </View>

      {list.error ? <Banner tone={c.pinkSoft} action="Try again" onAction={list.reload}>{explain(list.error)}</Banner> : null}
      {d?.totals.length ? (
        <Section title={filtered ? 'Totals for this selection' : 'Totals'} color={c.cyan}>
          <Card color={c.paper}>
            <View style={{ gap: 14 }}>{d.totals.map((m) => <Money key={m.currency} m={m} dense />)}</View>
            <T size={11} color={c.mute} style={{ marginTop: 8 }}>Read from the agreements themselves. Currencies are never added together, and a payment only counts as received once the recipient confirms it.</T>
          </Card>
        </Section>) : null}

      <Section title={d ? `${d.total} ${d.total === 1 ? 'beneficiary' : 'beneficiaries'}` : 'Beneficiaries'} color={c.sun}>
        {list.loading && !d ? <Loading /> : d?.items.length ? d.items.map((it) => (
          <Card key={`${it.target_type}:${it.target_id}`} color={c.paper} onPress={() => open(it)} accessibilityLabel={`${it.name}, ${KIND[it.target_type]}, ${STAGE[it.stage][0]}. ${it.risks.length ? `${it.risks.length} flags.` : ''}`}>
            <View style={{ gap: 8 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <View style={{ flex: 1 }}><T weight="800" size={16}>{it.name}</T><T size={12} color={c.mute}>{KIND[it.target_type]} · {it.agreements.active} active · {it.agreements.proposed} offered · {it.applications.open} applying</T></View>
                <Tag label={STAGE[it.stage][0]} color={STAGE[it.stage][1]} />
              </View>
              {it.money.length ? <View style={{ gap: 10 }}>{it.money.map((m) => <Money key={m.currency} m={m} dense />)}</View> : <T size={12} color={c.mute}>No cash terms yet.</T>}
              <Risks codes={it.risks} />
              {it.next_milestone_on ? <T size={12} color={c.mute}>Next milestone {when(it.next_milestone_on)}</T> : null}
            </View>
          </Card>)) : (
          <Empty emoji={filtered ? '🔎' : '🤝'} title={filtered ? 'No beneficiaries match' : d?.view === 'recipient' ? 'No sponsors yet' : 'No beneficiaries yet'}
            sub={filtered ? 'Try removing a filter.' : d?.view === 'recipient' ? 'When a sponsor makes you an offer or funds an application, it appears here.' : 'Make an offer or award a funding application and the beneficiary appears here.'} />)}
        {filtered && d?.items.length === 0 ? <Btn small title="Clear filters" color={c.paper} ink={c.ink} onPress={reset} style={{ alignSelf: 'flex-start' }} /> : null}
        {d && d.total > PAGE ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <Btn small title="Previous" color={c.paper} ink={c.ink} disabled={offset === 0 || list.loading} onPress={() => setOffset(Math.max(0, offset - PAGE))} />
            <T size={12} color={c.mute} accessibilityLiveRegion="polite">{offset + 1}–{Math.min(offset + PAGE, d.total)} of {d.total}</T>
            <Btn small title="Next" color={c.paper} ink={c.ink} disabled={offset + PAGE >= d.total || list.loading} onPress={() => setOffset(offset + PAGE)} />
          </View>) : null}
      </Section>
      {d?.items.length ? <Btn small title="Export CSV" color={c.violet} loading={exporting} onPress={exportCsv} style={{ alignSelf: 'flex-start' }} /> : null}
    </Screen>
  );
}

const ACTION_GO = { sponsorship_id: 'SponsorDeal', program_id: 'SponsorProgram' };
const HISTORY = {
  application_submitted: 'Application submitted', application_awarded: 'Application awarded', application_declined: 'Application declined', award_issued: 'Award offer issued',
  award_accepted: 'Award accepted', award_declined: 'Award declined', payment_confirmed: 'Payment confirmed',
};
const DOC = { award_letter: '📄', payment_evidence: '🧾', endorsement_evidence: '📣' };

export function PortfolioEntry({ target_type, target_id, view }) {
  const { push } = useNav();
  const q = { ...(view ? { view } : {}) };
  const e = useLoad(() => api.get(`/beneficiary-portfolio/${target_type}/${target_id}`, q), [target_type, target_id, view]);
  const [fresh, setFresh] = useState(false); // the data changed on the server since this copy was loaded
  const snap = e.data?.snapshot;
  useEffect(() => {
    if (!snap) return undefined;
    setFresh(false);
    const t = setInterval(async () => { try { const n = await api.get(`/beneficiary-portfolio/${target_type}/${target_id}`, q); if (n.snapshot !== snap) setFresh(true); } catch { /* the next visit shows the error */ } }, 45000);
    return () => clearInterval(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap, target_type, target_id, view]);
  const d = e.data;
  if (e.loading && !d) return <Screen><Loading /></Screen>;
  if (e.error && !d) return <Screen><LoadError error={e.error} onRetry={e.reload} /></Screen>;
  const go = (x) => { const key = Object.keys(ACTION_GO).find((k) => x[k]); if (key) push(ACTION_GO[key], { id: x[key] }); };
  const b = d.beneficiary;
  const recipient = d.view === 'recipient';
  return (
    <Screen refreshing={e.loading} onRefresh={e.reload}>
      <H1>{b.name}</H1>
      {recipient && b.target_type === 'athlete' && !b.youth_limited ? <Btn small title="Open my funding workspace" color={c.violet} style={{ alignSelf: 'flex-start' }} onPress={() => push('PlayerFunding', { athlete_id: b.target_id, name: b.name })} accessibilityLabel="Open the funding workspace for this athlete" /> : null}
      <T size={12} color={c.mute}>{KIND[b.target_type]} · {STAGE[b.stage][0]}{recipient ? ' · your sponsors' : ''}</T>
      {fresh ? <Banner tone={c.sunSoft} action="Refresh" onAction={e.reload}>This changed since you opened it — refresh to see the latest.</Banner> : null}
      {e.error ? <Banner tone={c.pinkSoft} action="Try again" onAction={e.reload}>{explain(e.error)}</Banner> : null}
      {b.youth_limited ? <Banner tone={c.violetSoft}>This beneficiary is under the age of independence. Their name and personal notes are not shown here; the agreement itself stays with them and their guardian.</Banner> : null}
      {d.risks.length ? <Risks codes={d.risks.map((r) => r.code)} /> : null}

      <Section title="Funding" color={c.cyan}>
        {d.totals.length ? <Card><View style={{ gap: 14 }}>{d.totals.map((m) => <Money key={m.currency} m={m} dense />)}</View></Card> : <Empty emoji="💸" title="No cash terms yet" sub="Goods and endorsement terms appear under each agreement." />}
        {!recipient && d.other_public_sponsors > 0 ? <T size={12} color={c.mute}>{d.other_public_sponsors} other {d.other_public_sponsors === 1 ? 'sponsor also supports' : 'sponsors also support'} this beneficiary publicly. Their terms are not shown.</T> : null}
      </Section>

      <Section title={`Next actions${d.next_actions.length ? ` (${d.next_actions.length})` : ''}`} color={c.pink}>
        {d.next_actions.length ? d.next_actions.map((a, i) => (
          <Card key={`${a.code}${i}`} color={c.sunSoft} onPress={() => go(a)} accessibilityLabel={a.label}><View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><T style={{ flex: 1 }} size={13}>{a.label}</T><T size={12} color={c.mute}>Open ›</T></View></Card>))
          : <Empty emoji="✅" title="Nothing needs you" sub="Overdue items, confirmations and reviews that need your role appear here." />}
      </Section>

      <Section title="Agreements" color={c.mint}>
        {d.agreements.length ? d.agreements.map((a) => (
          <Card key={a.id} onPress={() => push('SponsorDeal', { id: a.id })} accessibilityLabel={`Open agreement with ${a.sponsor.name}`}>
            <View style={{ gap: 6 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}><T weight="800" style={{ flex: 1 }}>{a.sponsor.name}</T><Tag label={a.status} color={a.status === 'active' ? c.lime : a.status === 'proposed' ? c.sunSoft : c.paper} /></View>
              <T size={12} color={c.mute}>{a.agreement_ref ?? 'Legacy agreement'}{a.program ? ` · ${a.program.name}` : ''}{a.starts_on ? ` · ${when(a.starts_on)} – ${a.ends_on ? when(a.ends_on) : 'open'}` : ''}</T>
              {a.lines.map((l, i) => <T key={i} size={12}>{l.label} · {l.kind}{l.kind === 'money' ? ` · ${l.total_cents ? `${fmt(l.total_cents, l.currency)} total` : `${fmt(l.amount_cents, l.currency)} each`}` : ''}{l.kind === 'goods' ? ` · ${l.quantity} ${l.unit ?? ''}` : ''}</T>)}
              {a.money.map((m) => <Money key={m.currency} m={{ ...m, requested_cents: 0, awarded_cents: 0, offered_cents: 0, gap_cents: 0 }} dense />)}
              {a.legacy ? <T size={12} color={c.mute}>{a.legacy.note}</T> : null}
            </View>
          </Card>)) : <Empty emoji="🤝" title="No agreements yet" sub="Accepted awards and offers become agreements here." />}
      </Section>

      {d.applications.length ? (
        <Section title="Funding applications" color={c.violet}>
          {d.applications.map((a) => (
            <Card key={a.id}><View style={{ gap: 4 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}><T weight="800" style={{ flex: 1 }}>{a.program.name}</T><Tag label={a.status} color={a.status === 'awarded' ? c.lime : a.status === 'submitted' ? c.sunSoft : c.paper} /></View>
              <T size={12} color={c.mute}>{a.sponsor.name} · {a.program.round}</T>
              <T size={13}>Requested {fmt(a.requested_cents, a.currency)}{a.awarded_cents != null ? ` · awarded ${fmt(a.awarded_cents, a.currency)}` : a.offered_cents != null ? ` · offered ${fmt(a.offered_cents, a.currency)}, not yet accepted` : ' · not yet awarded'}</T>
            </View></Card>))}
        </Section>) : null}

      <Section title="Milestones" color={c.sun}>
        {d.milestones.length ? d.milestones.slice(0, 12).map((m, i) => (
          <Card key={i} color={m.overdue ? c.pinkSoft : c.paper} onPress={() => m.sponsorship_id && push('SponsorDeal', { id: m.sponsorship_id })} accessibilityLabel={`${when(m.due_on)} ${m.label}`}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}><T size={13} weight="700" style={{ flex: 1 }}>{when(m.due_on)} · {m.label}</T><Tag label={m.overdue ? 'overdue' : m.type.replace('_', ' ')} color={m.overdue ? c.pinkSoft : c.violetSoft} /></View>
            {m.amount_cents != null ? <T size={12} color={c.mute}>{fmt(m.amount_cents, m.currency)}</T> : null}
          </Card>)) : <Empty emoji="📅" title="No upcoming dates" />}
      </Section>

      <Section title="Support history" color={c.lime}>
        {d.history.length ? d.history.slice(0, 20).map((h, i) => (
          <T key={i} size={13} accessibilityRole="text">{when(h.at)} · {HISTORY[h.kind] ?? h.label}{h.detail ? ` · ${h.detail}` : ''}</T>)) : <Empty emoji="🕘" title="No history yet" />}
      </Section>

      <Section title="Documents" color={c.cyan}>
        {d.documents.length ? d.documents.slice(0, 15).map((x, i) => (
          <Card key={i} onPress={() => push('SponsorDeal', { id: x.sponsorship_id })} accessibilityLabel={x.label}><T size={13}>{DOC[x.kind]} {x.label} · {when(x.at)}</T></Card>)) : <Empty emoji="📁" title="No documents yet" sub="Award letters and payment or endorsement evidence appear here." />}
      </Section>

      {!b.youth_limited ? (
        <Section title="Reviews" color={c.mint}>
          {d.reviews.length ? d.reviews.slice(0, 10).map((r) => (
            <Card key={r.id}><T size={13}>{r.body}</T><T size={12} color={c.mute}>{r.author} · {when(r.created_at)}{r.visibility === 'author_only' ? ' · only you' : ''}{r.next_review_on ? ` · next review ${when(r.next_review_on)}` : ''}</T>{r.response ? <T size={12}>Reply: {r.response}</T> : null}</Card>)) : <Empty emoji="📝" title="No reviews yet" />}
        </Section>) : null}
    </Screen>
  );
}
