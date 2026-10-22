import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Btn, Card, Chip, Empty, Field, H1, Loading, Row, Screen, Section, Seg, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { EntityPicker } from '../entity-picker';
import { SportSelect } from '../sportpicker';
import { c } from '../theme';
import { explain, LoadError } from '../access';

// Amounts are minor units of THEIR OWN currency; currencies are never added together.
const fmt = (cents, cur) => { try { const f = new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }); return f.format(cents / 10 ** f.resolvedOptions().maximumFractionDigits); } catch { return `${cents} ${cur ?? ''}`; } };
const when = (iso) => (iso ? new Date(`${String(iso).slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const STATUS_TONE = { draft: c.sunSoft, published: c.lime, closed: c.pinkSoft, archived: c.paper, open: c.lime, scheduled: c.sunSoft, submitted: c.sunSoft, awarded: c.lime, declined: c.pinkSoft, withdrawn: c.paper };
const MAY = ['manager', 'approver', 'admin', 'owner', 'portfolio_manager']; // sponsor roles, and an entity representative's own role names (#282)
const TARGET_LABEL = { athlete: 'Athletes', team: 'Teams', event: 'Events' };

const programFields = (brands, create) => [
  ...(create ? [{ key: 'sponsor_id', label: 'Brand', type: 'choice', options: brands.map((s) => ({ value: s.id, label: `${s.emoji ?? ''} ${s.name}`.trim() })) }] : []),
  { key: 'name', label: 'Program name' },
  { key: 'objective', label: 'Objective', type: 'multiline', optional: true, hint: 'What this funding is meant to achieve. Applicants see it.' },
  { key: 'currency', label: 'Currency', type: 'currency' },
  { key: 'budget_cents', label: 'Total budget', type: 'money', currency: (v) => v.currency },
  { key: 'max_award_cents', label: 'Largest single award', type: 'money', currency: (v) => v.currency, optional: true },
  { key: 'max_awards', label: 'Most awards (0 = no limit)', type: 'stepper', min: 0, max: 1000, default: 0 },
  { key: 'sports', label: 'Sports', type: 'sports', optional: true, hint: 'Leave empty to fund any sport.' },
  { key: 'regions', label: 'Regions', type: 'regions', optional: true, hint: 'Leave empty to fund anywhere. An applicant whose region is on record must match.' },
  { key: 'target_types', label: 'Who can apply', type: 'multi', options: [{ value: 'athlete', label: 'Athletes' }, { value: 'team', label: 'Teams' }, { value: 'event', label: 'Events' }], default: ['athlete', 'team', 'event'] },
  { key: 'verified_only', label: 'Verified applicants only', type: 'switch' },
  { key: 'starts_on', label: 'Funding period', type: 'daterange', toKey: 'ends_on', optional: true },
  { key: 'recurring', label: 'Runs in recurring rounds', type: 'switch' },
  { key: 'cadence', label: 'A new round every', type: 'chips', options: [{ value: 'monthly', label: 'Month' }, { value: 'quarterly', label: 'Quarter' }, { value: 'yearly', label: 'Year' }], default: 'monthly', show: (v) => v.recurring },
  { key: 'open_days', label: 'Each round stays open for (days)', type: 'stepper', min: 1, max: 365, default: 14, show: (v) => v.recurring },
];
const toBody = (v) => {
  const { recurring, cadence, open_days, max_awards, ...rest } = v;
  return { ...rest, max_awards: max_awards || undefined, recurrence: recurring ? { cadence, open_days } : undefined };
};

const Bar = ({ done, total }) => (
  <View accessible accessibilityRole="progressbar" accessibilityLabel={`${total ? Math.round((done / total) * 100) : 0} percent of the budget awarded`} style={{ height: 8, borderRadius: 4, backgroundColor: c.line, overflow: 'hidden', marginVertical: 6 }}>
    <View style={{ width: `${total ? Math.min(100, (done / total) * 100) : 0}%`, height: 8, backgroundColor: c.pink }} />
  </View>
);

/** Brand staff: the programs of the brands I run. */
export function SponsorPrograms() {
  const { push } = useNav();
  const [status, setStatus] = useState('published');
  const [form, setForm] = useState(false);
  const list = useLoad(() => api.get('/sponsorship-programs', { status, limit: 50 }), [status]);
  const brands = useLoad(() => api.get('/sponsors', { mine: true, limit: 50 }), []);
  const may = (brands.data ?? []).filter((b) => MAY.includes(b.my_role));
  return (
    <Screen onRefresh={list.reload} refreshing={list.loading && !!list.data}>
      <H1>Programs</H1>
      <T size={13} color={c.mute}>Funding programs of your brands: set the budget and rules, open rounds, and award applications. Awards become sponsorship agreements.</T>
      {may.length ? <Btn small title="New program" color={c.pink} style={{ alignSelf: 'flex-start', marginTop: 6 }} onPress={() => setForm(true)} accessibilityLabel="Create a new sponsorship program" /> : null}
      <Seg options={[{ value: 'draft', label: 'Draft' }, { value: 'published', label: 'Published' }, { value: 'closed', label: 'Closed' }, { value: 'archived', label: 'Archived' }]} value={status} onChange={setStatus} color={c.pink} />
      {list.error ? <LoadError error={list.error} onRetry={list.reload} /> : list.loading && !list.data ? <Loading /> : list.data?.length ? list.data.map((p) => (
        <Card key={p.id} onPress={() => push('SponsorProgram', { id: p.id })} accessibilityLabel={`${p.name}, ${p.status}. Open program`}>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><T weight="900" style={{ flex: 1 }}>{p.name}</T><Tag label={p.status} color={STATUS_TONE[p.status]} /></View>
          <T size={12} color={c.mute}>{p.sponsor_name} · {fmt(p.awarded_cents, p.currency)} of {fmt(p.budget_cents, p.currency)} awarded · {p.awards} award{p.awards === 1 ? '' : 's'}</T>
          <Bar done={p.awarded_cents} total={p.budget_cents} />
          <T size={12}>{p.open_round_id ? `Round open until ${when(p.open_round_closes_on)}` : 'No round open'}{p.pending_applications ? ` · ${p.pending_applications} to review` : ''}</T>
        </Card>
      )) : <Empty emoji="🎯" title={`No ${status} programs`} sub={may.length ? 'Create a program to start funding athletes, teams and events.' : 'Programs of the brands you run appear here.'} />}
      <FormSheet visible={form} onClose={() => setForm(false)} title="New sponsorship program" submitLabel="Create draft" fields={programFields(may, true)}
        onSubmit={async (v) => { const p = await api.post('/sponsorship-programs', toBody(v)); list.reload(); push('SponsorProgram', { id: p.id }); return 'Draft created — add a round, then publish'; }} />
    </Screen>
  );
}

/** One program: budget, rounds, applications and awards. */
export function SponsorProgram({ id }) {
  const { toast } = useSession();
  const { push } = useNav();
  const [form, setForm] = useState(null); // 'edit' | 'round' | { round } | 'schedule' | { award } | 'owner'
  const [roundId, setRoundId] = useState(null);
  const prog = useLoad(() => api.get(`/sponsorship-programs/${id}`), [id]);
  const apps = useLoad(() => api.get(`/sponsorship-programs/${id}/applications`, { limit: 100, ...(roundId ? { round_id: roundId } : {}) }), [id, roundId, prog.data?.row_version]);
  const p = prog.data;
  const reloadAll = () => { prog.reload(); apps.reload(); };
  const act = async (fn, m) => { try { await fn(); if (m) toast(m); reloadAll(); } catch (e) { toast(explain(e)); if (e.status === 409) reloadAll(); } };
  if (prog.loading && !p) return <Screen><Loading /></Screen>;
  if (prog.error) return <Screen><LoadError error={prog.error} onRetry={prog.reload} /></Screen>;
  const may = MAY.includes(p.my_role);
  const status = (s, m) => act(() => api.post(`/sponsorship-programs/${p.id}/status`, { status: s, version: p.row_version }), m);
  const download = async () => { try { const r = await api.get(`/sponsorship-programs/${p.id}/awards-export`); if (typeof document !== 'undefined') { const u = URL.createObjectURL(new Blob([r.csv], { type: 'text/csv' })); const l = document.createElement('a'); l.href = u; l.download = r.filename; l.click(); URL.revokeObjectURL(u); } toast(`${r.rows} award${r.rows === 1 ? '' : 's'} exported`); } catch (e) { toast(explain(e)); } };
  const editing = typeof form === 'object' && form?.round;
  const awarding = typeof form === 'object' && form?.award;
  return (
    <Screen onRefresh={reloadAll} refreshing={prog.loading && !!p}>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><H1 style={{ flex: 1 }}>{p.name}</H1><Tag label={p.status} color={STATUS_TONE[p.status]} /></View>
      <T size={12} color={c.mute}>{p.sponsor_name} · you: {p.my_role}{p.starts_on ? ` · ${when(p.starts_on)} – ${p.ends_on ? when(p.ends_on) : 'open'}` : ''}</T>
      <Card>
        <T weight="900">{fmt(p.awarded_cents, p.currency)} of {fmt(p.budget_cents, p.currency)} awarded</T>
        <Bar done={p.awarded_cents} total={p.budget_cents} />
        <T size={12} color={c.mute}>{fmt(p.remaining_cents, p.currency)} remaining · {p.awards} award{p.awards === 1 ? '' : 's'}{p.max_awards ? ` of ${p.max_awards}` : ''}{p.max_award_cents ? ` · up to ${fmt(p.max_award_cents, p.currency)} each` : ''}</T>
        {p.objective ? <T size={13} style={{ marginTop: 6 }}>{p.objective}</T> : null}
        <T size={12} color={c.mute} style={{ marginTop: 6 }}>{[p.sports.length ? p.sports.join(', ') : 'Any sport', p.regions.length ? p.regions.join(', ') : 'Anywhere', (p.eligibility?.target_types ?? []).map((t) => TARGET_LABEL[t]).join(', '), p.eligibility?.verified_only ? 'Verified only' : null].filter(Boolean).join(' · ')}</T>
        {may ? (
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            {['draft', 'published'].includes(p.status) ? <Btn small title="Edit" color={c.violet} onPress={() => setForm('edit')} /> : null}
            {['draft', 'published'].includes(p.status) ? <Btn small title="Change owner" color={c.paper} ink={c.ink} onPress={() => setForm('owner')} /> : null}
            {p.status === 'draft' ? <Btn small title="Publish" color={c.mint} ink={c.ink} onPress={() => status('published', 'Published — applicants can now see open rounds')} /> : null}
            {p.status === 'published' ? <Btn small title="Close program" color={c.paper} ink={c.red} onPress={() => status('closed', 'Closed — no new applications')} /> : null}
            {p.status === 'closed' ? <Btn small title="Reopen" color={c.mint} ink={c.ink} onPress={() => status('published', 'Reopened')} /> : null}
            {['draft', 'closed'].includes(p.status) ? <Btn small title="Archive" color={c.paper} ink={c.red} onPress={() => status('archived', 'Archived — kept on record')} /> : null}
          </View>
        ) : <T size={12} color={c.mute} style={{ marginTop: 8 }}>Your role can read this program; managers and approvers run it.</T>}
      </Card>
      <Section title="Rounds" color={c.sun} action={may && ['draft', 'published'].includes(p.status) ? '+ Round' : undefined} onAction={() => setForm('round')}>
        {p.rounds.length ? p.rounds.map((r) => (
          <Card key={r.id} color={c.sunSoft}>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><T weight="900" style={{ flex: 1 }}>{r.name}</T><Tag label={r.state} color={STATUS_TONE[r.state]} /></View>
            <T size={12} color={c.mute}>{when(r.opens_on)} – {when(r.closes_on)} · {r.pending} to review · {r.awards} awarded ({fmt(r.awarded_cents, p.currency)}){r.budget_cents != null ? ` of ${fmt(r.budget_cents, p.currency)}` : ''}{r.max_awards ? ` · max ${r.max_awards}` : ''} · terms v{r.terms_version}</T>
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              <Chip label={roundId === r.id ? 'Showing applications ✓' : 'Show applications'} active={roundId === r.id} onPress={() => setRoundId(roundId === r.id ? null : r.id)} />
              {may && r.status !== 'closed' ? <Btn small title="Edit" color={c.violet} onPress={() => setForm({ round: r })} /> : null}
              {may && r.status !== 'closed' ? <Btn small title="Close round" color={c.paper} ink={c.red} onPress={() => act(() => api.post(`/program-rounds/${r.id}/close`, { version: r.row_version }), 'Round closed — no new applications')} /> : null}
            </View>
          </Card>
        )) : <Empty emoji="🗓️" title="No rounds yet" sub="A round is a window in which applications are accepted." />}
        {may && p.recurrence && ['draft', 'published'].includes(p.status) ? <Btn small title="Schedule recurring rounds" color={c.paper} ink={c.ink} style={{ alignSelf: 'flex-start' }} onPress={() => setForm('schedule')} /> : null}
      </Section>
      <Section title={roundId ? 'Applications (selected round)' : 'Applications'} color={c.cyan}>
        {apps.error ? <LoadError error={apps.error} onRetry={apps.reload} /> : apps.loading && !apps.data ? <Loading /> : apps.data?.length ? apps.data.map((a) => (
          <Card key={a.id}>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><View style={{ flex: 1 }}><T weight="900">{a.display_name} → {a.target_name ?? a.target_type}</T><T size={12} color={c.mute}>{a.round_name} · asks {fmt(a.requested_cents, a.currency)}{a.awarded_cents ? ` · awarded ${fmt(a.awarded_cents, a.currency)}` : ''} · terms v{a.round_terms_version}</T></View><Tag label={a.status} color={STATUS_TONE[a.status]} /></View>
            {a.pitch ? <T size={13} style={{ marginTop: 6 }}>{a.pitch}</T> : null}
            {a.decision_reason ? <T size={12} color={c.mute}>Note: {a.decision_reason}</T> : null}
            {a.status === 'submitted' && may ? <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}><Btn small title="Award" color={c.mint} ink={c.ink} onPress={() => setForm({ award: a })} /><Btn small title="Decline" color={c.paper} ink={c.red} onPress={() => act(() => api.patch(`/program-applications/${a.id}`, { decision: 'decline' }), 'Declined')} /></View> : null}
            {a.sponsorship_id ? <Btn small title="Open agreement" color={c.violet} style={{ alignSelf: 'flex-start', marginTop: 8 }} onPress={() => push('SponsorDeal', { id: a.sponsorship_id })} /> : null}
          </Card>
        )) : <Empty emoji="📬" title="No applications" sub={p.status === 'published' ? 'They appear here as applicants submit to an open round.' : 'Publish the program to receive applications.'} />}
        {['manager', 'finance', 'auditor', 'admin'].includes(p.my_role) ? <Btn small title="Export awards (CSV)" color={c.paper} ink={c.ink} style={{ alignSelf: 'flex-start' }} onPress={download} /> : null}
      </Section>

      <FormSheet visible={form === 'edit'} onClose={() => setForm(null)} title="Edit program" fields={programFields([], false)}
        initial={{ ...p, regions: p.regions, target_types: p.eligibility?.target_types, verified_only: !!p.eligibility?.verified_only, max_awards: p.max_awards ?? 0, recurring: !!p.recurrence, cadence: p.recurrence?.cadence, open_days: p.recurrence?.open_days, starts_on: p.starts_on ? String(p.starts_on).slice(0, 10) : undefined, ends_on: p.ends_on ? String(p.ends_on).slice(0, 10) : undefined }}
        onSubmit={async (v) => { const b = toBody(v); await api.patch(`/sponsorship-programs/${p.id}`, { ...b, version: p.row_version, sports: v.sports ?? [], regions: v.regions ?? [], starts_on: v.starts_on ?? null, ends_on: v.ends_on ?? null, max_awards: v.max_awards || null, max_award_cents: b.max_award_cents ?? null, recurrence: b.recurrence ?? null, objective: b.objective ?? null }); reloadAll(); return 'Saved — applications already submitted keep their original terms'; }} />
      <FormSheet visible={form === 'round'} onClose={() => setForm(null)} title="New round" submitLabel="Add round"
        fields={[{ key: 'name', label: 'Name', optional: true, hint: 'Defaults to “Round N”.' }, { key: 'opens_on', label: 'Applications open', type: 'daterange', toKey: 'closes_on' }, { key: 'budget_cents', label: 'Round budget', type: 'money', currency: p.currency, optional: true, hint: 'Leave empty to draw on the program budget.' }, { key: 'max_awards', label: 'Most awards in this round (0 = no limit)', type: 'stepper', min: 0, max: 1000, default: 0 }]}
        onSubmit={async (v) => { await api.post(`/sponsorship-programs/${p.id}/rounds`, { ...v, max_awards: v.max_awards || undefined }); reloadAll(); return 'Round added'; }} />
      <FormSheet visible={!!editing} onClose={() => setForm(null)} title="Edit round" fields={[{ key: 'name', label: 'Name' }, { key: 'opens_on', label: 'Applications open', type: 'daterange', toKey: 'closes_on' }, { key: 'budget_cents', label: 'Round budget', type: 'money', currency: p.currency, optional: true }, { key: 'max_awards', label: 'Most awards (0 = no limit)', type: 'stepper', min: 0, max: 1000, default: 0 }]}
        initial={editing ? { ...editing, opens_on: String(editing.opens_on).slice(0, 10), closes_on: String(editing.closes_on).slice(0, 10), max_awards: editing.max_awards ?? 0 } : {}}
        onSubmit={async (v) => { await api.patch(`/program-rounds/${editing.id}`, { ...v, version: editing.row_version, budget_cents: v.budget_cents ?? null, max_awards: v.max_awards || null }); reloadAll(); return 'Saved — a new terms version applies to later applications only'; }} />
      <FormSheet visible={form === 'schedule'} onClose={() => setForm(null)} title="Schedule recurring rounds" submitLabel="Create rounds"
        fields={[{ key: 'through', label: 'Create rounds up to', type: 'date', hint: 'Follows the program cadence from its first round. Repeating this creates nothing twice.' }]}
        onSubmit={async (v) => { const r = await api.post(`/sponsorship-programs/${p.id}/schedule-rounds`, v); reloadAll(); return r.created ? `${r.created} round${r.created === 1 ? '' : 's'} created` : 'Nothing new to create'; }} />
      <FormSheet visible={!!awarding} onClose={() => setForm(null)} title={`Award ${awarding?.display_name ?? ''}`} submitLabel="Award and send agreement"
        fields={[{ key: 'awarded_cents', label: `Amount (asked ${awarding ? fmt(awarding.requested_cents, awarding.currency) : ''})`, type: 'money', currency: p.currency }, { key: 'reason', label: 'Note to the applicant', type: 'multiline', optional: true }]}
        initial={awarding ? { awarded_cents: awarding.requested_cents } : {}}
        onSubmit={async (v) => { await api.patch(`/program-applications/${awarding.id}`, { decision: 'award', program_version: p.row_version, awarded_cents: v.awarded_cents, reason: v.reason }); reloadAll(); return 'Awarded — the recipient now has an agreement to accept'; }} />
      <OwnerSheet visible={form === 'owner'} onClose={() => setForm(null)} onPick={(u) => act(() => api.patch(`/sponsorship-programs/${p.id}`, { version: p.row_version, owner_id: u.id }), 'Owner changed')} />
    </Screen>
  );
}

function OwnerSheet({ visible, onClose, onPick }) {
  const [sel, setSel] = useState([]);
  return (
    <Sheet visible={visible} onClose={onClose} title="Program owner">
      <T size={13} color={c.mute}>The person accountable for the program. They must run this brand.</T>
      <EntityPicker label="Owner" value={sel} onChange={setSel} noun="person" />
      <Btn title="Make owner" disabled={!sel.length} onPress={() => { onPick(sel[0]); onClose(); }} />
    </Sheet>
  );
}

/** Applicants: programs with an open round, and my applications. */
export function FundingOpportunities() {
  const { user, toast } = useSession();
  const { push } = useNav();
  const [q, setQ] = useState('');
  const [sport, setSport] = useState(null);
  const [apply, setApply] = useState(null); // { program, round }
  const opps = useLoad(() => api.get('/funding-opportunities', { limit: 50, ...(q.trim() ? { q: q.trim() } : {}), ...(sport ? { sport } : {}) }), [q, sport]);
  const mine = useLoad(() => api.get('/my/program-applications', { limit: 50 }), []);
  const teams = useLoad(() => (apply ? api.get('/teams', { mine: true, limit: 50 }) : Promise.resolve([])), [!!apply]);
  const evs = useLoad(() => (apply ? api.get('/events', { organizer_id: user.id, limit: 50 }) : Promise.resolve([])), [!!apply]);
  const reload = () => { opps.reload(); mine.reload(); };
  const act = async (fn, m) => { try { await fn(); toast(m); reload(); } catch (e) { toast(explain(e)); if (e.status === 409) reload(); } };
  const el = apply?.program.eligibility?.target_types ?? ['athlete', 'team', 'event'];
  const targets = [
    ...(el.includes('athlete') ? [{ value: `athlete:${user.id}`, label: 'Myself (athlete)' }] : []),
    ...(el.includes('team') ? (teams.data ?? []).map((t) => ({ value: `team:${t.id}`, label: `Team · ${t.name}` })) : []),
    ...(el.includes('event') ? (evs.data ?? []).map((e) => ({ value: `event:${e.id}`, label: `Event · ${e.name}` })) : []),
  ];
  return (
    <Screen onRefresh={reload} refreshing={opps.loading && !!opps.data}>
      <H1>Funding opportunities</H1>
      <T size={13} color={c.mute}>Sponsor programs with a round open for applications. Apply for yourself, a team you own or an event you organise.</T>
      <Field value={q} onChangeText={setQ} placeholder="Search programs and sponsors…" />
      <SportSelect value={sport} onChange={setSport} allLabel="All sports" />
      {opps.error ? <LoadError error={opps.error} onRetry={opps.reload} /> : opps.loading && !opps.data ? <Loading /> : opps.data?.length ? opps.data.map((p) => (
        <Card key={p.id}>
          <T weight="900">{p.name}</T>
          <T size={12} color={c.mute}>{p.sponsor_name}{p.max_award_cents ? ` · up to ${fmt(p.max_award_cents, p.currency)}` : ''} · {p.currency}</T>
          {p.objective ? <T size={13} style={{ marginTop: 4 }}>{p.objective}</T> : null}
          <T size={12} color={c.mute}>{[p.sports.length ? p.sports.join(', ') : 'Any sport', p.regions.length ? p.regions.join(', ') : 'Anywhere', (p.eligibility?.target_types ?? []).map((t) => TARGET_LABEL[t]).join(', '), p.eligibility?.verified_only ? 'Verified applicants only' : null].filter(Boolean).join(' · ')}</T>
          {(p.rounds ?? []).map((r) => (
            <View key={r.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 }}>
              <T size={12} style={{ flex: 1 }}>{r.name} · open until {when(r.closes_on)}</T>
              <Btn small title="Apply" color={c.pink} onPress={() => setApply({ program: p, round: r })} accessibilityLabel={`Apply to ${p.name}, ${r.name}`} />
            </View>
          ))}
        </Card>
      )) : <Empty emoji="🔎" title="No open programs right now" sub="Check back later — programs appear here while a round is open." />}
      <Section title="My applications" color={c.mint}>
        {mine.error ? <LoadError error={mine.error} onRetry={mine.reload} /> : mine.loading && !mine.data ? <Loading /> : mine.data?.length ? mine.data.map((a) => (
          <Card key={a.id}>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><View style={{ flex: 1 }}><T weight="900">{a.program_name} · {a.round_name}</T><T size={12} color={c.mute}>{a.sponsor_name} · for {a.target_name ?? a.target_type} · asked {fmt(a.requested_cents, a.currency)}{a.awarded_cents ? ` · awarded ${fmt(a.awarded_cents, a.currency)}` : ''}</T></View><Tag label={a.status} color={STATUS_TONE[a.status]} /></View>
            <T size={12} color={c.mute}>Made under round terms v{a.round_terms_version}, closing {when(a.terms_snapshot?.round?.closes_on)}.</T>
            {a.decision_reason ? <T size={12}>Note: {a.decision_reason}</T> : null}
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
              {a.status === 'submitted' ? <Btn small title="Withdraw" color={c.paper} ink={c.red} onPress={() => act(() => api.post(`/program-applications/${a.id}/withdraw`), 'Application withdrawn')} /> : null}
              {a.sponsorship_id ? <Btn small title="Open agreement" color={c.violet} onPress={() => push('SponsorDeal', { id: a.sponsorship_id })} /> : null}
            </View>
          </Card>
        )) : <Empty emoji="✉️" title="No applications yet" />}
      </Section>
      <FormSheet visible={!!apply} onClose={() => setApply(null)} title={apply ? `Apply · ${apply.program.name}` : ''} submitLabel="Submit application"
        fields={[{ key: 'sec', type: 'section', label: apply ? `${apply.round.name} · closes ${when(apply.round.closes_on)}${apply.program.max_award_cents ? ` · up to ${fmt(apply.program.max_award_cents, apply.program.currency)}` : ''}` : '' },
          { key: 'target', label: 'Applying for', type: 'choice', options: targets.length ? targets : [{ value: '', label: 'Nothing you own is eligible' }] },
          { key: 'requested_cents', label: 'Amount you are asking for', type: 'money', currency: apply?.program.currency },
          { key: 'pitch', label: 'Why should this be funded?', type: 'multiline', optional: true }]}
        onSubmit={async (v) => {
          const [target_type, target_id] = String(v.target ?? '').split(':');
          if (!target_id) throw new Error('Choose what you are applying for');
          await api.post(`/program-rounds/${apply.round.id}/applications`, { target_type, target_id, requested_cents: v.requested_cents, pitch: v.pitch }); reload(); return 'Application submitted — the terms you applied under are kept with it';
        }} />
    </Screen>
  );
}
