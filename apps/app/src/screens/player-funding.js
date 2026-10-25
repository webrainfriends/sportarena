// Player funding workspace (#334): needs, sponsorship applications, awarded support, dues, goods and next actions in one place, for the player, a
// verified guardian, or a coach the player shared it with. Logic lives in the API capabilities (get_player_funding_workspace and friends);
// this only calls them. Phone: one column with section chips. Tablet and desktop: totals and next actions sit beside the section.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { useLayout } from '../layout';
import { Btn, Card, Chip, Empty, H1, Loading, Row, Screen, Section, T, Tag } from '../ui';
import { HScroll } from '../ui';
import { FormSheet } from '../FormSheet';
import { c } from '../theme';
import { explain, LoadError } from '../access';
import { cash, key, saveFile } from '../contracts-ui';
import { OfferSheet } from './sponsor-awards';

const PAGE = 25;
const inDays = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const when = (d) => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const CATEGORY = [['equipment', 'Equipment'], ['travel', 'Travel'], ['coaching', 'Coaching'], ['competition_fees', 'Competition fees'], ['medical_rehab', 'Medical & rehab'], ['education', 'Education'], ['living_training', 'Living & training'], ['other', 'Other']]
  .map(([value, label]) => ({ value, label }));
const PURPOSE = [{ value: 'funding_planning', label: 'Funding planning' }, { value: 'application_support', label: 'Help with applications' }, { value: 'paperwork', label: 'Paperwork' }];
const SECTION_OPTS = [{ value: 'needs', label: 'Funding needs' }, { value: 'applications', label: 'Applications' }, { value: 'support', label: 'Agreements & terms' }, { value: 'dues', label: 'Dues, paid & confirmed' }];
const SECTION_NAME = { needs: 'Needs', applications: 'Applications', support: 'Support', dues: 'Dues' };
const STATE = { scheduled: ['Scheduled', c.violetSoft], overdue: ['Overdue', c.pinkSoft], fulfilled: ['Done', c.mint], on_hold: ['On hold', c.sunSoft], cancelled: ['Cancelled', c.paper] };
const APP = { submitted: ['Submitted', c.violetSoft], awarded: ['Awarded', c.mint], declined: ['Declined', c.pinkSoft], withdrawn: ['Withdrawn', c.paper] };
const LINK = { secured: ['Secured', c.mint], pending: ['Pending', c.sunSoft], lapsed: ['No longer counts', c.paper] };
const ICON = { answer_award: '🏅', answer_offer: '✉️', confirm_payment: '💰', confirm_receipt: '📦', submit_endorsement: '📣', review_endorsement: '👀', overdue_from_sponsor: '⏰', meet_condition: '📋', agreement_ending: '📅', fund_need: '🎯' };
const BLOCKED = { expired: 'Ended', revoked: 'Stopped', no_relationship: 'Coach no longer coaches you', guardian_consent: 'A guardian has not given current consent', no_medical_grant: 'Not available' };

const Banner = ({ tone = c.sunSoft, children }) => <View accessibilityRole="alert" style={{ backgroundColor: tone, borderRadius: 12, padding: 12 }}><T size={13}>{children}</T></View>;

/** One currency block: every number in its own currency, requested/awarded/offered kept apart, received = confirmed only. */
function Totals({ totals }) {
  if (!totals?.length) return null;
  return (
    <Card>
      {totals.filter((m) => Object.entries(m).some(([k, v]) => k.endsWith('_cents') && v > 0)).map((m) => {
        const cells = [['Requested', m.requested_cents], ['Awarded', m.awarded_cents], ['Offered, not accepted', m.offered_cents], ['Still unfunded', m.gap_cents],
          ['Committed', m.committed_cents], ['Received (confirmed)', m.confirmed_cents], ['Reported, unconfirmed', m.reported_unconfirmed_cents], ['Outstanding', m.outstanding_cents]].filter(([, v]) => v != null && v > 0);
        return (
          <View key={m.currency} accessible accessibilityLabel={`${m.currency}: ${cells.map(([l, v]) => `${l} ${cash(v, m.currency)}`).join(', ') || 'nothing yet'}`} style={{ gap: 6, marginBottom: 6 }}>
            <T size={12} weight="800" color={c.mute}>{m.currency}</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 18, rowGap: 6 }}>
              {cells.length ? cells.map(([l, v]) => <View key={l} style={{ minWidth: 112 }}><T size={11} color={c.mute}>{l}</T><T size={15} weight="800" color={l === 'Still unfunded' ? c.pink : c.ink}>{cash(v, m.currency)}</T></View>) : <T size={13} color={c.mute}>Nothing requested or committed in this currency yet.</T>}
            </View>
          </View>);
      })}
    </Card>
  );
}

const Bar = ({ need }) => {
  const pct = (v) => `${Math.min(100, (v / need.amount_cents) * 100)}%`;
  return (
    <View accessible accessibilityLabel={`Secured ${cash(need.secured_cents, need.currency)}, pending ${cash(need.pending_cents, need.currency)}, not yet covered ${cash(need.gap_cents, need.currency)} of ${cash(need.amount_cents, need.currency)}`} style={{ height: 10, borderRadius: 5, backgroundColor: c.violetSoft, overflow: 'hidden', flexDirection: 'row' }}>
      <View style={{ width: pct(need.secured_cents), backgroundColor: c.mint }} />
      <View style={{ width: pct(need.pending_cents), backgroundColor: c.sun }} />
    </View>
  );
};

export function PlayerFunding({ athlete_id, name }) {
  const { user, toast } = useSession();
  const { push } = useNav();
  const L = useLayout();
  const athleteId = athlete_id ?? user.id;
  const mine = athleteId === user.id;
  const who = mine ? {} : { athlete_id: athleteId };
  const [tab, setTab] = useState('overview');
  const [state, setState] = useState(null);
  const [pg, setPg] = useState(0);
  const [offer, setOffer] = useState(null);
  const [form, setForm] = useState(null); // { need?, key } | { link: need } | { share?, recipients }
  const q = useLoad(() => api.get('/player-funding', { ...who, ...(state ? { state } : {}), limit: PAGE, offset: pg * PAGE }), [athleteId, state, pg]);
  const shared = useLoad(() => (mine ? api.get('/funding-shared', { limit: 50 }) : Promise.resolve([])), [mine]);
  const w = q.data;

  if (q.loading && !w) return <Screen><Loading /></Screen>;
  if (q.error && !w) return <Screen><LoadError error={q.error} onRetry={q.reload} /></Screen>;
  const owner = w.access.role !== 'staff';
  const has = (s) => w.access.sections.includes(s);
  const tabs = [['overview', 'Overview'], ...['needs', 'applications', 'support', 'dues'].filter(has).map((s) => [s, SECTION_NAME[s]]), ...(owner ? [['sharing', 'Sharing']] : [])];
  const run = async (fn, ok) => { try { await fn(); toast(ok); q.reload(); } catch (e) { toast(explain(e)); if (e.status === 409) q.reload(); } };
  const exportCsv = async () => { try { const r = await api.get('/player-funding/export', who); await saveFile(r.filename, r.csv); toast(`${r.rows} row${r.rows === 1 ? '' : 's'} exported`); } catch (e) { toast(explain(e)); } };
  const openAction = (a) => {
    if (a.code === 'answer_award') setOffer(a.entity.id);
    else if (a.entity.type === 'sponsorship') push('SponsorDeal', { id: a.entity.id });
    else if (a.entity.type === 'need') setTab('needs');
  };
  const title = mine ? 'Funding' : `${w.athlete.display_name ?? name ?? 'Athlete'}'s funding`;

  const actions = owner ? (
    <Section title="Next actions" color={c.pink}>
      {w.next_actions?.length ? w.next_actions.slice(0, 8).map((a, i) => (
        <Row key={`${a.code}-${a.entity.id}-${i}`} left={<T size={20}>{ICON[a.code] ?? '•'}</T>} title={a.label} sub={a.due_on ? `Date: ${when(a.due_on)}` : undefined}
          onPress={() => openAction(a)} right={<Tag label={a.priority === 1 ? 'Needs you' : 'Soon'} color={a.priority === 1 ? c.sun : c.violetSoft} />} />))
        : <Empty emoji="✅" title="Nothing waiting on you" sub="Offers to answer, payments to confirm and evidence to send show up here." />}
    </Section>) : null;

  const needs = has('needs') ? (
    <Section title="Funding needs" color={c.mint} action={owner ? 'Add a need' : undefined} onAction={() => setForm({ need: null, key: key() })}>
      {w.needs?.length ? w.needs.map((n) => (
        <Card key={n.id} style={{ opacity: n.status === 'withdrawn' ? 0.6 : 1 }}>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <View style={{ flex: 1 }}><T weight="900">{n.title}</T><T size={12} color={c.mute}>{CATEGORY.find((x) => x.value === n.category)?.label}{n.needed_by ? ` · needed by ${when(n.needed_by)}` : ''}</T></View>
            <T weight="800">{cash(n.amount_cents, n.currency)}</T>
          </View>
          {n.status === 'open' ? <>
            <View style={{ height: 8 }} /><Bar need={n} />
            <T size={12} color={c.mute} style={{ marginTop: 6 }}>Secured {cash(n.secured_cents, n.currency)} · pending {cash(n.pending_cents, n.currency)} · {n.met ? 'fully covered' : `not yet covered ${cash(n.gap_cents, n.currency)}`}</T>
          </> : <Tag label="Withdrawn" color={c.paper} />}
          {n.links.map((l) => (
            <View key={l.id} style={{ flexDirection: 'row', gap: 8, alignItems: 'center', marginTop: 6 }}>
              <T size={12} style={{ flex: 1 }}>{l.label} · {cash(l.counted_cents, n.currency)}</T><Tag label={LINK[l.state][0]} color={LINK[l.state][1]} />
              {owner ? <Btn small title="Release" color={c.paper} ink={c.ink} accessibilityLabel={`Stop counting ${l.label} towards ${n.title}`} onPress={() => run(() => api.post(`/funding-need-links/${l.id}/release`, { rev: n.rev }), 'Link released')} /> : null}
            </View>))}
          {n.note ? <T size={12} color={c.mute} style={{ marginTop: 6 }}>{n.note}</T> : null}
          {owner ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
              {n.status === 'open' ? <>
                <Btn small title="Link support" color={c.violet} onPress={() => setForm({ link: n })} />
                {!n.met ? <Btn small title="Find funding" color={c.paper} ink={c.ink} onPress={() => push('FundingOpportunities')} /> : null}
                <Btn small title="Edit" color={c.paper} ink={c.ink} onPress={() => setForm({ need: n })} />
                <Btn small title="Withdraw" color={c.paper} ink={c.red} onPress={() => run(() => api.patch(`/funding-needs/${n.id}`, { rev: n.rev, status: 'withdrawn' }), 'Need withdrawn')} />
              </> : <Btn small title="Reopen" color={c.paper} ink={c.ink} onPress={() => run(() => api.patch(`/funding-needs/${n.id}`, { rev: n.rev, status: 'open' }), 'Need reopened')} />}
            </View>) : null}
        </Card>))
        : <Empty emoji="🎯" title="No funding needs yet" sub={owner ? 'Say what you need funded (kit, travel, coaching, fees) and link the applications and agreements that cover it.' : 'Nothing has been added.'} />}
    </Section>) : null;

  const applications = has('applications') ? (
    <Section title="Applications & offers" color={c.violet}>
      {w.applications?.length ? w.applications.map((a) => (
        <Card key={a.id} accessibilityLabel={`${a.program.name}, ${a.sponsor.name}, requested ${cash(a.requested_cents, a.currency)}`}>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <View style={{ flex: 1 }}><T weight="900">{a.program.name}</T><T size={12} color={c.mute}>{a.sponsor.name}{a.program.round ? ` · ${a.program.round}` : ''} · sent {when(a.submitted_at)}</T></View>
            {a.award?.status === 'issued' ? <Tag label="Offer to answer" color={c.sun} /> : <Tag label={(APP[a.status] ?? [a.status, c.paper])[0]} color={(APP[a.status] ?? [0, c.paper])[1]} />}
          </View>
          <T size={13} style={{ marginTop: 6 }}>Requested {cash(a.requested_cents, a.currency)}{a.awarded_cents != null ? ` · awarded ${cash(a.awarded_cents, a.currency)}` : ''}</T>
          {a.award ? <T size={12} color={c.mute}>Offer {a.award.status}{a.award.status === 'issued' ? ` · answer before ${when(a.award.expires_at)}` : ''}</T> : null}
          {a.award?.status === 'issued' && owner ? <Btn small title="Review the offer" color={c.pink} style={{ alignSelf: 'flex-start', marginTop: 8 }} onPress={() => setOffer(a.award.id)} /> : null}
        </Card>))
        : <Empty emoji="📨" title="No applications yet" sub="Apply to a sponsorship call and it appears here with every offer and answer." />}
      {owner ? <Btn small title="Find sponsorship calls" color={c.violet} style={{ alignSelf: 'flex-start' }} onPress={() => push('FundingOpportunities')} /> : null}
    </Section>) : null;

  const support = has('support') ? (
    <Section title="Awarded support & agreements" color={c.cyan}>
      {w.support?.length ? w.support.map((d) => (
        <Card key={d.id} onPress={owner ? () => push('SponsorDeal', { id: d.id }) : undefined} accessibilityLabel={`${d.sponsor.name} agreement, ${d.status}`}>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <View style={{ flex: 1 }}><T weight="900">{d.sponsor.name}</T><T size={12} color={c.mute}>{d.agreement_ref ?? 'Agreement'}{d.starts_on ? ` · ${when(d.starts_on)} – ${when(d.ends_on)}` : ''}</T></View>
            <Tag label={d.status.replace(/_/g, ' ')} color={d.status === 'active' ? c.mint : c.violetSoft} />
          </View>
          {d.lines.map((l) => (
            <T key={l.id} size={13} style={{ marginTop: 4 }}>
              {l.kind === 'money' ? `💰 ${l.label}: ${cash(l.total_cents ?? l.amount_cents * l.instalments, l.currency)}` : l.kind === 'goods' ? `📦 ${l.label}: ${l.quantity} ${l.unit ?? ''}${l.estimate_cents ? ` (estimated value ${cash(l.estimate_cents, l.currency)}, not cash)` : ''}` : l.kind === 'endorsement' ? `📣 ${l.label}` : `🛠 ${l.label}`}
            </T>))}
          {d.legacy ? <T size={12} color={c.mute} style={{ marginTop: 4 }}>{d.legacy.note}</T> : null}
        </Card>))
        : <Empty emoji="🤝" title="No agreements yet" sub="Accepted awards and sponsor offers become agreements here." />}
    </Section>) : null;

  const dues = has('dues') ? (
    <Section title="Dues, paid & confirmed" color={c.sun}>
      <HScroll>
        {[[null, 'All'], ['overdue', 'Overdue'], ['upcoming', 'Upcoming'], ['fulfilled', 'Done']].map(([v, l]) => <Chip key={l} label={l} active={state === v} onPress={() => { setState(v); setPg(0); }} />)}
      </HScroll>
      {w.dues.conditions.length ? <Banner>{w.dues.conditions.length} condition{w.dues.conditions.length === 1 ? '' : 's'} still open{w.dues.conditions.some((x) => x.blocks_payment) ? ', some of which hold up payment' : ''}.</Banner> : null}
      {w.dues.items.length ? w.dues.items.map((d) => {
        const [sl, sc] = STATE[d.state] ?? [d.state, c.paper];
        return (
          <Card key={d.id} onPress={owner ? () => push('SponsorDeal', { id: d.sponsorship_id }) : undefined}>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
              <View style={{ flex: 1 }}><T weight="900">{d.label}</T><T size={12} color={c.mute}>{d.sponsor} · due {when(d.due_on)}</T></View>
              <Tag label={sl} color={sc} />
            </View>
            {d.money ? <T size={13} style={{ marginTop: 6 }}>{cash(d.money.amount_cents, d.currency)} due · confirmed {cash(d.money.confirmed_cents, d.currency)}{d.money.reported_unconfirmed_cents ? ` · reported, unconfirmed ${cash(d.money.reported_unconfirmed_cents, d.currency)}` : ''}{d.money.outstanding_cents ? ` · outstanding ${cash(d.money.outstanding_cents, d.currency)}` : ''}</T> : null}
            {d.goods ? <T size={13} style={{ marginTop: 6 }}>📦 {d.goods.received} of {d.goods.committed} received{d.goods.in_transit ? ` · ${d.goods.in_transit} on the way` : ''}{d.goods.returned ? ` · ${d.goods.returned} returned` : ''}{d.goods.remaining ? ` · ${d.goods.remaining} still to send` : ''}</T> : null}
            {d.endorsement ? <T size={13} style={{ marginTop: 6 }}>📣 {d.endorsement.promoter === 'recipient' ? 'You promote' : 'The sponsor promotes'}{d.endorsement.submission_status ? ` · evidence ${d.endorsement.submission_status.replace('_', ' ')}` : ' · no evidence yet'}</T> : null}
          </Card>);
      }) : <Empty emoji="🗓️" title="Nothing due" sub={state ? 'No dues match this filter.' : 'When an agreement is accepted, each payment, delivery and promotion appears here with its due date.'} />}
      {w.dues.total > PAGE ? (
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          <Btn small title="Previous" color={c.paper} ink={c.ink} disabled={pg === 0} onPress={() => setPg(pg - 1)} />
          <T size={12} color={c.mute}>{pg * PAGE + 1}–{Math.min(w.dues.total, (pg + 1) * PAGE)} of {w.dues.total}</T>
          <Btn small title="Next" color={c.paper} ink={c.ink} disabled={(pg + 1) * PAGE >= w.dues.total} onPress={() => setPg(pg + 1)} />
        </View>) : null}
    </Section>) : null;

  const section = { overview: <>{L.tablet ? null : actions}{needs}</>, needs, applications, support, dues, sharing: owner ? <Sharing athleteId={athleteId} mine={mine} form={form} setForm={setForm} /> : null }[tab];

  return (
    <Screen wide refreshing={q.loading} onRefresh={q.reload}>
      <H1>{title}</H1>
      <T size={12} color={c.mute}>{w.access.role === 'guardian' ? 'You are viewing this as a guardian. ' : w.access.role === 'staff' ? `Shared with you: ${w.access.sections.map((s) => SECTION_NAME[s]).join(', ')}. ` : ''}Updated {new Date(w.as_of).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}. {w.basis}</T>
      {q.error ? <Banner tone={c.pinkSoft}>Could not refresh: {explain(q.error)}</Banner> : null}
      {mine && shared.data?.length ? (
        <Section title="Shared with you" color={c.cyan}>
          {shared.data.map((s) => <Row key={s.id} title={s.athlete.display_name ?? 'Unavailable'} sub={s.blocked ? BLOCKED[s.blocked] : `${s.sections.map((x) => SECTION_NAME[x]).join(', ')} · until ${when(s.expires_at)}`} onPress={s.blocked ? undefined : () => push('PlayerFunding', { athlete_id: s.athlete.id, name: s.athlete.display_name })} />)}
        </Section>) : null}
      <Totals totals={w.totals} />
      {w.needs_totals?.length ? <T size={12} color={c.mute}>Needs: {w.needs_totals.map((t) => `${cash(t.needed_cents, t.currency)} (${cash(t.gap_cents, t.currency)} not yet covered)`).join(' · ')}</T> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {w.access.can_export ? <Btn small title="Export CSV" color={c.paper} ink={c.ink} accessibilityLabel="Export the funding workspace as a CSV file" onPress={exportCsv} /> : null}
      </View>
      <HScroll>{tabs.map(([v, l]) => <Chip key={v} label={l} active={tab === v} onPress={() => setTab(v)} />)}</HScroll>
      {L.tablet && tab === 'overview' ? (
        <View style={{ flexDirection: 'row', gap: 16, alignItems: 'flex-start' }}>
          <View style={{ flex: 1, minWidth: 0, gap: 12 }}>{needs}</View>
          <View style={{ width: 340, gap: 12 }}>{actions}</View>
        </View>) : <View style={{ gap: 12 }}>{section}</View>}

      <OfferSheet id={offer} onClose={() => setOffer(null)} onChanged={q.reload} />
      <NeedForm form={form} athleteId={athleteId} mine={mine} close={() => setForm(null)} done={q.reload} w={w} />
    </Screen>
  );
}

/** Create / edit a need, or link an application or agreement to it. Right control for each answer: chips, money, calendar. */
function NeedForm({ form, athleteId, mine, close, done, w }) {
  if (!form || form.share !== undefined || form.recipients) return null;
  if (form.link) {
    const n = form.link;
    const apps = (w.applications ?? []).filter((a) => ['submitted', 'awarded'].includes(a.status) && a.currency === n.currency && !(a.award?.status === 'accepted'));
    const deals = (w.support ?? []).filter((d) => d.lines.some((l) => l.kind === 'money' && l.currency === n.currency) && ['proposed', 'active', 'paused', 'ended', 'term_expired', 'completed'].includes(d.status));
    const options = [...apps.map((a) => ({ value: `a:${a.id}`, label: `Application · ${a.sponsor.name} · ${a.program.name}` })), ...deals.map((d) => ({ value: `d:${d.id}`, label: `Agreement · ${d.sponsor.name}${d.agreement_ref ? ` · ${d.agreement_ref}` : ''}` }))];
    if (!options.length) return <FormSheet visible onClose={close} title="Link support" submitLabel="Close" fields={[{ key: 'x', label: `No application or agreement in ${n.currency} can cover this need yet. Apply to a sponsorship call, or create the need in the currency of the support you expect.`, type: 'section' }]} onSubmit={async () => { close(); return 'Nothing to link'; }} />;
    return (
      <FormSheet visible onClose={close} title={`Link support to “${n.title}”`} submitLabel="Link" initial={{ target: options[0].value, allocated_cents: Math.max(1, n.gap_cents) }}
        fields={[{ key: 'target', label: 'Which application or agreement covers it?', type: 'chips', options }, { key: 'allocated_cents', label: 'How much of it covers this need?', type: 'money', currency: n.currency, hint: 'The same money can only be claimed once across your needs.' }]}
        onSubmit={async (v) => { const [k, tid] = v.target.split(':'); await api.post(`/funding-needs/${n.id}/links`, { rev: n.rev, allocated_cents: v.allocated_cents, ...(k === 'a' ? { application_id: tid } : { sponsorship_id: tid }) }); done(); close(); return 'Linked'; }} />
    );
  }
  const n = form.need;
  return (
    <FormSheet visible onClose={close} title={n ? 'Edit funding need' : 'Add a funding need'} submitLabel={n ? 'Save' : 'Add need'}
      initial={n ? { category: n.category, title: n.title, amount_cents: n.amount_cents, currency: n.currency, needed_by: n.needed_by, note: n.note } : { category: 'equipment', needed_by: inDays(60) }}
      fields={[
        { key: 'category', label: 'What is it for?', type: 'chips', options: CATEGORY },
        { key: 'title', label: 'Short title' },
        { key: 'currency', label: 'Currency', type: 'currency' },
        { key: 'amount_cents', label: 'How much do you need?', type: 'money', currency: (v) => v.currency },
        { key: 'needed_by', label: 'Needed by', type: 'date', optional: true, min: inDays(0) },
        { key: 'note', label: 'Notes (private to you and your guardian)', type: 'multiline', optional: true },
      ]}
      onSubmit={async (v) => {
        const body = { category: v.category, title: v.title, amount_cents: v.amount_cents, currency: v.currency, needed_by: v.needed_by || null, note: v.note || null };
        if (n) await api.patch(`/funding-needs/${n.id}`, { rev: n.rev, ...body });
        else await api.post('/funding-needs', { ...(mine ? {} : { athlete_id: athleteId }), ...body, needed_by: body.needed_by ?? undefined, note: body.note ?? undefined, client_key: form.key });
        done(); close(); return n ? 'Saved' : 'Need added';
      }} />
  );
}

/** Owner side: who can see this workspace, what they see, until when, and who looked. */
function Sharing({ athleteId, mine, setForm, form }) {
  const { toast } = useSession();
  const who = mine ? {} : { athlete_id: athleteId };
  const sh = useLoad(() => api.get('/funding-shares', who), [athleteId]);
  const [sure, setSure] = useState(null);
  if (sh.loading && !sh.data) return <Loading />;
  if (sh.error) return <LoadError error={sh.error} onRetry={sh.reload} />;
  const openForm = async (share) => {
    try { setForm({ share: share ?? null, recipients: share ? [] : await api.get('/funding-shares/recipients', who) }); } catch (e) { toast(explain(e)); }
  };
  const live = sh.data.shares.filter((s) => s.state === 'active');
  const revoke = async (s) => {
    if (sure !== s.id) { setSure(s.id); return; }
    try { await api.post(`/funding-shares/${s.id}/revoke`, {}); toast('Sharing stopped'); setSure(null); sh.reload(); } catch (e) { toast(explain(e)); }
  };
  const f = form?.recipients ? form : null;
  return (
    <Section title="Who can see this" color={c.cyan} action="Share with a coach" onAction={() => openForm(null)}>
      <T size={12} color={c.mute}>Only a coach who currently coaches {mine ? 'you' : 'this athlete'} can be chosen. Access ends the moment you stop sharing, the coaching ends, or (for a young athlete) a guardian withdraws consent. Your private notes are never shared.</T>
      {live.length ? live.map((s) => (
        <Card key={s.id}>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <View style={{ flex: 1 }}><T weight="900">{s.recipient_name}</T><T size={12} color={c.mute}>{PURPOSE.find((p) => p.value === s.purpose)?.label} · {s.sections.map((x) => SECTION_NAME[x]).join(', ')}{s.can_export ? ' · may export' : ''} · until {when(s.expires_at)}</T></View>
            <Tag label={s.blocked ? 'Paused' : 'Active'} color={s.blocked ? c.sunSoft : c.mint} />
          </View>
          {s.blocked ? <T size={12} color={c.mute}>{s.blocked_reason}</T> : null}
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
            <Btn small title="Change" color={c.paper} ink={c.ink} onPress={() => openForm(s)} />
            <Btn small title={sure === s.id ? 'Tap again to stop sharing' : 'Stop sharing'} color={c.paper} ink={c.red} accessibilityLabel={`Stop sharing with ${s.recipient_name}`} onPress={() => revoke(s)} />
          </View>
        </Card>)) : <Empty emoji="🔒" title="Not shared with anyone" sub="Your funding picture is visible only to you (and your guardian if you are young)." />}
      {sh.data.events.length ? <>
        <T weight="800" size={13}>History</T>
        {sh.data.events.slice(0, 10).map((e) => <T key={e.id} size={12} color={c.mute}>{new Date(e.created_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} · {e.recipient_name} · {e.action}</T>)}
      </> : null}
      {f ? (
        <FormSheet visible onClose={() => setForm(null)} title={f.share ? 'Change sharing' : 'Share with a coach'} submitLabel={f.share ? 'Save' : 'Share'}
          initial={f.share ? { sections: f.share.sections, can_export: f.share.can_export, expires_on: String(f.share.expires_at).slice(0, 10) } : { purpose: 'funding_planning', sections: ['needs'], can_export: false, expires_on: inDays(90), recipient_id: f.recipients[0]?.id }}
          fields={[
            ...(f.share ? [] : [
              { key: 'recipient_id', label: 'Which coach?', type: 'chips', options: f.recipients.map((r) => ({ value: r.id, label: r.display_name })), hint: f.recipients.length ? undefined : 'No coach currently coaches you.' },
              { key: 'purpose', label: 'Why?', type: 'chips', options: PURPOSE }]),
            { key: 'sections', label: 'What can they see?', type: 'multi', options: SECTION_OPTS },
            { key: 'can_export', label: 'Allow CSV export', type: 'switch' },
            { key: 'expires_on', label: 'Until', type: 'date', min: inDays(0), max: inDays(365) },
          ]}
          onSubmit={async (v) => {
            if (f.share) await api.patch(`/funding-shares/${f.share.id}`, { version: f.share.version, sections: v.sections, can_export: v.can_export, expires_on: v.expires_on });
            else { if (!v.recipient_id) throw new Error('Choose a coach'); await api.post('/funding-shares', { ...who, recipient_id: v.recipient_id, purpose: v.purpose, sections: v.sections, can_export: v.can_export, expires_on: v.expires_on }); }
            setForm(null); sh.reload(); return f.share ? 'Sharing updated' : 'Shared';
          }} />) : null}
    </Section>
  );
}
