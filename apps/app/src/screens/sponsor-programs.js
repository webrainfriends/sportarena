import React, { useState } from 'react';
import { Platform, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Btn, Card, Chip, Empty, Field, H1, Loading, Row, Screen, Section, Seg, Sheet, T, Tag } from '../ui';
import { RegionPicker } from '../region-picker';
import { FormSheet } from '../FormSheet';
import { EntityPicker } from '../entity-picker';
import { SportSelect } from '../sportpicker';
import { c } from '../theme';
import { explain, LoadError } from '../access';
import { fieldsOf, filled, fmtMoney } from '../application-forms';

// Amounts are minor units of THEIR OWN currency; currencies are never added together.
const fmt = (cents, cur) => { try { const f = new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }); return f.format(cents / 10 ** f.resolvedOptions().maximumFractionDigits); } catch { return `${cents} ${cur ?? ''}`; } };
const when = (iso) => (iso ? new Date(`${String(iso).slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const STATUS_TONE = { draft: c.sunSoft, published: c.lime, closed: c.pinkSoft, archived: c.paper, open: c.lime, scheduled: c.sunSoft, submitted: c.sunSoft, returned: c.pinkSoft, awarded: c.lime, declined: c.pinkSoft, withdrawn: c.paper };
const MAY = ['manager', 'approver', 'admin'];
const myZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };
/** A deadline instant shown in the round's own timezone, so everyone reads the same moment. */
const deadline = (instant, zone) => { if (!instant) return ''; try { return `${new Date(instant).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: zone || 'UTC' })} (${zone || 'UTC'})`; } catch { return String(instant); } };
const VISIBILITY_LABEL = { public: 'Public call', invitation_only: 'Invitation only' };
const INVITE_TONE = { invited: c.sunSoft, viewed: c.sunSoft, applied: c.lime, declined: c.pinkSoft, revoked: c.paper };

/** A persistent notice (stale version, closed call...). Role "alert" so assistive tech announces it. */
const Banner = ({ tone = c.sunSoft, children, action, onAction }) => (
  <View accessibilityRole="alert" style={{ backgroundColor: tone, borderRadius: 12, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
    <T size={13} style={{ flex: 1 }}>{children}</T>
    {action ? <Btn small title={action} color={c.paper} ink={c.ink} onPress={onAction} accessibilityLabel={action} /> : null}
  </View>
);
const TARGET_LABEL = { athlete: 'Athletes', team: 'Teams', event: 'Events' };

const programFields = (brands, create) => [
  ...(create ? [{ key: 'sponsor_id', label: 'Brand', type: 'choice', options: brands.map((s) => ({ value: s.id, label: `${s.emoji ?? ''} ${s.name}`.trim() })) }] : []),
  { key: 'name', label: 'Program name' },
  { key: 'objective', label: 'Objective', type: 'multiline', optional: true, hint: 'What this funding is meant to achieve. Applicants see it.' },
  { key: 'visibility', label: 'Who can see this call', type: 'chips', options: [{ value: 'public', label: 'Public — searchable' }, { value: 'invitation_only', label: 'Invitation only' }], default: 'public', hint: 'Invitation-only calls are never listed or searchable; only the people you invite can open and apply.' },
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
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><T weight="900" style={{ flex: 1 }}>{p.name}</T>{p.visibility === 'invitation_only' ? <Tag label="Invitation only" color={c.violetSoft} /> : null}<Tag label={p.status} color={STATUS_TONE[p.status]} /></View>
          <T size={12} color={c.mute}>{p.sponsor_name} · {fmt(p.awarded_cents, p.currency)} of {fmt(p.budget_cents, p.currency)} awarded · {p.awards} award{p.awards === 1 ? '' : 's'}</T>
          <Bar done={p.awarded_cents} total={p.budget_cents} />
          <T size={12}>{p.open_round_id ? `Round open until ${deadline(p.open_round_closes_at, null)}` : 'No round open'}{p.pending_applications ? ` · ${p.pending_applications} to review` : ''}</T>
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
  const [stale, setStale] = useState(false);
  const prog = useLoad(() => api.get(`/sponsorship-programs/${id}`), [id]);
  const apps = useLoad(() => api.get(`/sponsorship-programs/${id}/applications`, { limit: 100, ...(roundId ? { round_id: roundId } : {}) }), [id, roundId, prog.data?.row_version]);
  const p = prog.data;
  const invs = useLoad(() => api.get(`/sponsorship-programs/${id}/invitations`, { limit: 100 }), [id]);
  const reloadAll = () => { prog.reload(); apps.reload(); invs.reload(); };
  const act = async (fn, m) => { try { await fn(); if (m) toast(m); setStale(false); reloadAll(); } catch (e) { toast(explain(e)); if (e.status === 409) { setStale(true); reloadAll(); } } };
  if (prog.loading && !p) return <Screen><Loading /></Screen>;
  if (prog.error) return <Screen><LoadError error={prog.error} onRetry={prog.reload} /></Screen>;
  const may = MAY.includes(p.my_role);
  const status = (s, m) => act(() => api.post(`/sponsorship-programs/${p.id}/status`, { status: s, version: p.row_version }), m);
  const download = async () => { try { const r = await api.get(`/sponsorship-programs/${p.id}/awards-export`); if (typeof document !== 'undefined') { const u = URL.createObjectURL(new Blob([r.csv], { type: 'text/csv' })); const l = document.createElement('a'); l.href = u; l.download = r.filename; l.click(); URL.revokeObjectURL(u); } toast(`${r.rows} award${r.rows === 1 ? '' : 's'} exported`); } catch (e) { toast(explain(e)); } };
  const editing = typeof form === 'object' && form?.round;
  const faqEdit = typeof form === 'object' && form?.faq;
  const awarding = typeof form === 'object' && form?.award;
  return (
    <Screen onRefresh={reloadAll} refreshing={prog.loading && !!p}>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><H1 style={{ flex: 1 }}>{p.name}</H1><Tag label={p.status} color={STATUS_TONE[p.status]} /></View>
      {stale ? <Banner action="Dismiss" onAction={() => setStale(false)}>Someone else changed this program while you were working. The latest version is shown now — review it and try again.</Banner> : null}
      <T size={12} color={c.mute}>{VISIBILITY_LABEL[p.visibility]} · {p.sponsor_name} · you: {p.my_role}{p.starts_on ? ` · ${when(p.starts_on)} – ${p.ends_on ? when(p.ends_on) : 'open'}` : ''}</T>
      <Card>
        <T weight="900">{fmt(p.awarded_cents, p.currency)} of {fmt(p.budget_cents, p.currency)} awarded</T>
        <Bar done={p.awarded_cents} total={p.budget_cents} />
        <T size={12} color={c.mute}>{fmt(p.remaining_cents, p.currency)} remaining · {p.awards} award{p.awards === 1 ? '' : 's'}{p.max_awards ? ` of ${p.max_awards}` : ''}{p.max_award_cents ? ` · up to ${fmt(p.max_award_cents, p.currency)} each` : ''}</T>
        {p.objective ? <T size={13} style={{ marginTop: 6 }}>{p.objective}</T> : null}
        <T size={12} color={c.mute} style={{ marginTop: 6 }}>{[p.sports.length ? p.sports.join(', ') : 'Any sport', p.regions.length ? p.regions.join(', ') : 'Anywhere', (p.eligibility?.target_types ?? []).map((t) => TARGET_LABEL[t]).join(', '), p.eligibility?.verified_only ? 'Verified only' : null].filter(Boolean).join(' · ')}</T>
        {may ? (
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            {['draft', 'published'].includes(p.status) ? <Btn small title="Edit" color={c.violet} onPress={() => setForm('edit')} /> : null}
            <Btn small title="Application forms" color={c.paper} ink={c.ink} onPress={() => push('FormBuilder', { program_id: p.id })} />
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
            <T size={12} color={c.mute}>Opens {when(r.opens_on)} · closes {deadline(r.closes_at ?? r.closes_on, r.timezone)} · {r.pending} to review · {r.awards} awarded ({fmt(r.awarded_cents, p.currency)}){r.budget_cents != null ? ` of ${fmt(r.budget_cents, p.currency)}` : ''}{r.max_awards ? ` · max ${r.max_awards}` : ''} · terms v{r.terms_version}</T>
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              <Chip label={roundId === r.id ? 'Showing applications ✓' : 'Show applications'} active={roundId === r.id} onPress={() => setRoundId(roundId === r.id ? null : r.id)} />
              {may && r.status !== 'closed' ? <Btn small title="Edit" color={c.violet} onPress={() => setForm({ round: r })} /> : null}
              {may && r.status !== 'closed' ? <Btn small title="Close round" color={c.paper} ink={c.red} onPress={() => act(() => api.post(`/program-rounds/${r.id}/close`, { version: r.row_version }), 'Round closed — no new applications')} /> : null}
            </View>
          </Card>
        )) : <Empty emoji="🗓️" title="No rounds yet" sub="A round is a window in which applications are accepted." />}
        {may && p.recurrence && ['draft', 'published'].includes(p.status) ? <Btn small title="Schedule recurring rounds" color={c.paper} ink={c.ink} style={{ alignSelf: 'flex-start' }} onPress={() => setForm('schedule')} /> : null}
      </Section>
      <Section title="Invitations" color={c.violet} action={may && ['draft', 'published'].includes(p.status) ? '+ Invite' : undefined} onAction={() => setForm('invite')}>
        <T size={12} color={c.mute}>{p.visibility === 'invitation_only' ? 'This call is invitation only: it is never listed or searchable, and only the people below can open it and apply.' : 'Public call: anyone can find it. Invitations let you also nudge specific athletes, teams or events.'}</T>
        {invs.error ? <LoadError error={invs.error} onRetry={invs.reload} /> : invs.loading && !invs.data ? <Loading /> : invs.data?.length ? invs.data.map((v) => (
          <Card key={v.id}>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><View style={{ flex: 1 }}><T weight="900">{v.target_name ?? v.target_type}</T><T size={12} color={c.mute}>{TARGET_LABEL[v.target_type]?.replace(/s$/, '')} · invited {when(v.created_at)} · @{v.invitee_handle}</T></View><Tag label={v.status} color={INVITE_TONE[v.status]} /></View>
            {may && ['invited', 'viewed'].includes(v.status) ? <Btn small title="Revoke" color={c.paper} ink={c.red} style={{ alignSelf: 'flex-start', marginTop: 8 }} onPress={() => act(() => api.post(`/program-invitations/${v.id}/revoke`), 'Invitation withdrawn')} accessibilityLabel={`Revoke the invitation to ${v.target_name}`} /> : null}
          </Card>
        )) : <Empty emoji="💌" title="No invitations yet" sub={may ? 'Invite athletes, teams or events to apply.' : undefined} />}
      </Section>
      <Section title="FAQs" color={c.mint} action={may && p.status !== 'archived' ? '+ FAQ' : undefined} onAction={() => setForm('faq')}>
        {p.faqs?.length ? p.faqs.map((f) => (
          <Card key={f.id}>
            <T weight="900">{f.question}</T><T size={13}>{f.answer}</T>
            {may && p.status !== 'archived' ? <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
              <Btn small title="Edit" color={c.violet} onPress={() => setForm({ faq: f })} accessibilityLabel={`Edit FAQ ${f.question}`} />
              <Btn small title="Remove" color={c.paper} ink={c.red} onPress={() => act(() => api.post(`/sponsorship-program-faqs/${f.id}/archive`, { version: f.row_version }), 'FAQ removed from the page')} accessibilityLabel={`Remove FAQ ${f.question}`} />
            </View> : null}
          </Card>
        )) : <Empty emoji="❓" title="No FAQs yet" sub="Answer what applicants usually ask; it shows on the public call page." />}
      </Section>
      <Section title={roundId ? 'Applications (selected round)' : 'Applications'} color={c.cyan}>
        {apps.error ? <LoadError error={apps.error} onRetry={apps.reload} /> : apps.loading && !apps.data ? <Loading /> : apps.data?.length ? apps.data.map((a) => (
          <Card key={a.id}>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><View style={{ flex: 1 }}><T weight="900">{a.target_type === 'athlete' && a.target_id === a.applicant_id ? a.display_name : `${a.display_name} → ${a.target_name ?? a.target_type}`}</T><T size={12} color={c.mute}>{a.round_name} · asks {fmt(a.requested_cents, a.currency)}{a.awarded_cents ? ` · awarded ${fmt(a.awarded_cents, a.currency)}` : ''} · terms v{a.round_terms_version}</T></View><Tag label={a.status} color={STATUS_TONE[a.status]} /></View>
            {a.pitch ? <T size={13} style={{ marginTop: 6 }}>{a.pitch}</T> : null}
            {a.receipt_no ? <T size={12} color={c.mute}>Receipt {a.receipt_no} · form v{a.form_version}</T> : null}
            {a.decision_reason ? <T size={12} color={c.mute}>Note: {a.decision_reason}</T> : null}
            {a.status === 'submitted' && may ? <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}><Btn small title="Award" color={c.mint} ink={c.ink} onPress={() => setForm({ award: a })} /><Btn small title="Decline" color={c.paper} ink={c.red} onPress={() => act(() => api.patch(`/program-applications/${a.id}`, { decision: 'decline' }), 'Declined')} /></View> : null}
            {a.form_id ? <Btn small title="Review answers" color={c.violet} style={{ alignSelf: 'flex-start', marginTop: 8 }} onPress={() => setForm({ view: a })} /> : null}
            {a.status === 'returned' ? <T size={12} color={c.mute}>Waiting for the applicant to correct it.</T> : null}
            {a.sponsorship_id ? <Btn small title="Open agreement" color={c.violet} style={{ alignSelf: 'flex-start', marginTop: 8 }} onPress={() => push('SponsorDeal', { id: a.sponsorship_id })} /> : null}
          </Card>
        )) : <Empty emoji="📬" title="No applications" sub={p.status === 'published' ? 'They appear here as applicants submit to an open round.' : 'Publish the program to receive applications.'} />}
        {['manager', 'finance', 'auditor', 'admin'].includes(p.my_role) ? <Btn small title="Export awards (CSV)" color={c.paper} ink={c.ink} style={{ alignSelf: 'flex-start' }} onPress={download} /> : null}
      </Section>

      <FormSheet visible={form === 'edit'} onClose={() => setForm(null)} title="Edit program" fields={programFields([], false)}
        initial={{ ...p, regions: p.regions, target_types: p.eligibility?.target_types, verified_only: !!p.eligibility?.verified_only, max_awards: p.max_awards ?? 0, recurring: !!p.recurrence, cadence: p.recurrence?.cadence, open_days: p.recurrence?.open_days, starts_on: p.starts_on ? String(p.starts_on).slice(0, 10) : undefined, ends_on: p.ends_on ? String(p.ends_on).slice(0, 10) : undefined }}
        onSubmit={async (v) => { const b = toBody(v); await api.patch(`/sponsorship-programs/${p.id}`, { ...b, version: p.row_version, sports: v.sports ?? [], regions: v.regions ?? [], starts_on: v.starts_on ?? null, ends_on: v.ends_on ?? null, max_awards: v.max_awards || null, max_award_cents: b.max_award_cents ?? null, recurrence: b.recurrence ?? null, objective: b.objective ?? null }); reloadAll(); return 'Saved — applications already submitted keep their original terms'; }} />
      <FormSheet visible={form === 'round'} onClose={() => setForm(null)} title="New round" submitLabel="Add round" initial={{ timezone: myZone() }}
        fields={[{ key: 'name', label: 'Name', optional: true, hint: 'Defaults to “Round N”.' }, { key: 'opens_on', label: 'Applications open', type: 'daterange', toKey: 'closes_on' }, { key: 'closes_time', label: 'Deadline time on the closing day', type: 'time', optional: true, hint: 'Leave empty for the end of the closing day.' }, { key: 'timezone', label: 'Deadline timezone', type: 'timezone' }, { key: 'budget_cents', label: 'Round budget', type: 'money', currency: p.currency, optional: true, hint: 'Leave empty to draw on the program budget.' }, { key: 'max_awards', label: 'Most awards in this round (0 = no limit)', type: 'stepper', min: 0, max: 1000, default: 0 }]}
        onSubmit={async (v) => { await api.post(`/sponsorship-programs/${p.id}/rounds`, { ...v, max_awards: v.max_awards || undefined }); reloadAll(); return 'Round added'; }} />
      <FormSheet visible={!!editing} onClose={() => setForm(null)} title="Edit round" fields={[{ key: 'name', label: 'Name' }, { key: 'opens_on', label: 'Applications open', type: 'daterange', toKey: 'closes_on' }, { key: 'closes_time', label: 'Deadline time on the closing day', type: 'time', optional: true }, { key: 'timezone', label: 'Deadline timezone', type: 'timezone' }, { key: 'budget_cents', label: 'Round budget', type: 'money', currency: p.currency, optional: true }, { key: 'max_awards', label: 'Most awards (0 = no limit)', type: 'stepper', min: 0, max: 1000, default: 0 }]}
        initial={editing ? { ...editing, opens_on: String(editing.opens_on).slice(0, 10), closes_on: String(editing.closes_on).slice(0, 10), max_awards: editing.max_awards ?? 0, closes_time: editing.closes_time ? String(editing.closes_time).slice(0, 5) : undefined, timezone: editing.timezone } : {}}
        onSubmit={async (v) => { await api.patch(`/program-rounds/${editing.id}`, { ...v, closes_time: v.closes_time ?? null, version: editing.row_version, budget_cents: v.budget_cents ?? null, max_awards: v.max_awards || null }); reloadAll(); return 'Saved — a new terms version applies to later applications only'; }} />
      <FormSheet visible={form === 'schedule'} onClose={() => setForm(null)} title="Schedule recurring rounds" submitLabel="Create rounds"
        fields={[{ key: 'through', label: 'Create rounds up to', type: 'date', hint: 'Follows the program cadence from its first round. Repeating this creates nothing twice.' }]}
        onSubmit={async (v) => { const r = await api.post(`/sponsorship-programs/${p.id}/schedule-rounds`, v); reloadAll(); return r.created ? `${r.created} round${r.created === 1 ? '' : 's'} created` : 'Nothing new to create'; }} />
      <FormSheet visible={!!awarding} onClose={() => setForm(null)} title={`Award ${awarding?.display_name ?? ''}`} submitLabel="Award and send agreement"
        fields={[{ key: 'awarded_cents', label: `Amount (asked ${awarding ? fmt(awarding.requested_cents, awarding.currency) : ''})`, type: 'money', currency: p.currency }, { key: 'reason', label: 'Note to the applicant', type: 'multiline', optional: true }]}
        initial={awarding ? { awarded_cents: awarding.requested_cents } : {}}
        onSubmit={async (v) => { await api.patch(`/program-applications/${awarding.id}`, { decision: 'award', program_version: p.row_version, awarded_cents: v.awarded_cents, reason: v.reason }); reloadAll(); return 'Awarded — the recipient now has an agreement to accept'; }} />
      <ReviewSheet app={typeof form === 'object' && form?.view ? form.view : null} may={may} onClose={() => setForm(null)} onChanged={reloadAll} />
      <FormSheet visible={form === 'faq' || !!faqEdit} onClose={() => setForm(null)} title={faqEdit ? 'Edit FAQ' : 'New FAQ'} submitLabel={faqEdit ? 'Save' : 'Add FAQ'}
        fields={[{ key: 'question', label: 'Question' }, { key: 'answer', label: 'Answer', type: 'multiline' }, { key: 'position', label: 'Position in the list (0 = first)', type: 'stepper', min: 0, max: 100, default: 0 }]}
        initial={faqEdit ? { question: faqEdit.question, answer: faqEdit.answer, position: faqEdit.position } : { position: p.faqs?.length ?? 0 }}
        onSubmit={async (v) => { try { await api.post(`/sponsorship-programs/${p.id}/faqs`, { ...v, ...(faqEdit ? { faq_id: faqEdit.id, version: faqEdit.row_version } : {}) }); } catch (e) { if (e.status === 409) { setStale(true); reloadAll(); } throw e; } reloadAll(); return faqEdit ? 'FAQ saved' : 'FAQ added'; }} />
      <InviteSheet visible={form === 'invite'} onClose={() => setForm(null)} programId={p.id} onDone={reloadAll} />
      <OwnerSheet visible={form === 'owner'} onClose={() => setForm(null)} onPick={(u) => act(() => api.patch(`/sponsorship-programs/${p.id}`, { version: p.row_version, owner_id: u.id }), 'Owner changed')} />
    </Screen>
  );
}

/** Brand staff: one application with the exact form version it was filled under; may be sent back for correction. */
function ReviewSheet({ app, may, onClose, onChanged }) {
  const { toast } = useSession();
  const detail = useLoad(() => (app ? api.get(`/program-applications/${app.id}`) : Promise.resolve(null)), [app?.id]);
  const [pick, setPick] = useState([]);
  const [reason, setReason] = useState('');
  const [asking, setAsking] = useState(false);
  const d = detail.data;
  const open = async (x) => { try { const blob = await api.download(`/application-files/${x.id}`); if (Platform.OS === 'web') { const u = URL.createObjectURL(blob); window.open(u, '_blank', 'noopener'); setTimeout(() => URL.revokeObjectURL(u), 120000); } else toast('Open documents in the web app'); } catch (e) { toast(explain(e)); } };
  const send = async () => { try { await api.post(`/program-applications/${app.id}/request-correction`, { reason, fields: pick }); toast('Sent back to the applicant'); setAsking(false); setPick([]); setReason(''); onChanged(); onClose(); } catch (e) { toast(explain(e)); } };
  const fields = d?.form ? fieldsOf(d.form.definition) : [];
  const show = (f) => { const v = d.answers[f.key]; return Array.isArray(v) ? v.map((x) => f.options?.find((o) => o.value === x)?.label ?? x).join(', ') : f.type === 'yesno' ? (v ? 'Yes' : 'No') : f.type === 'money' ? fmtMoney(v, d.currency) : f.options?.find((o) => o.value === v)?.label ?? String(v); };
  return (
    <Sheet visible={!!app} onClose={onClose} title={d?.receipt_no ? `Application ${d.receipt_no}` : 'Application'}>
      {detail.error ? <LoadError error={detail.error} onRetry={detail.reload} /> : !d ? <Loading /> : (
        <>
          <T size={12} color={c.mute}>Form version {d.form_version} · submitted {d.submitted_at ? new Date(d.submitted_at).toLocaleString() : ''} · asks {fmtMoney(d.requested_cents, d.currency)}. Confidential answers shown here are audit-logged.</T>
          {d.form.definition.sections.map((s) => (
            <View key={s.id} style={{ gap: 6 }}>
              <T weight="900">{s.title}</T>
              {s.fields.filter((f) => !['budget', 'references', 'file'].includes(f.type) && filled(d.answers[f.key])).map((f) => <View key={f.key}><T size={12} color={c.mute}>{f.label}{f.confidential ? ' 🔒' : ''}</T><T>{show(f)}</T></View>)}
              {s.fields.some((f) => f.type === 'budget') ? d.budget.map((l, i) => <T key={i}>{l.label} · {fmtMoney(l.amount_cents, d.currency)}</T>) : null}
              {s.fields.some((f) => f.type === 'references') ? d.references.map((r, i) => <T key={i}>{r.name} ({r.relationship}) · {[r.email, r.phone].filter(Boolean).join(' · ')} · {r.may_contact ? 'may be contacted' : 'on file only'}</T>) : null}
              {s.fields.filter((f) => f.type === 'file').flatMap((f) => d.files.filter((x) => x.field_key === f.key).map((x) => <Btn key={x.id} small title={`📎 ${x.original_name ?? 'File'}`} color={c.paper} ink={c.ink} onPress={() => open(x)} style={{ alignSelf: 'flex-start' }} />))}
            </View>
          ))}
          {d.events.map((e, i) => <T key={i} size={12} color={c.mute}>{e.kind.replace(/_/g, ' ')} · {new Date(e.created_at).toLocaleString()}{e.note ? ` — ${e.note}` : ''}</T>)}
          {may && d.status === 'submitted' && !asking ? <Btn small title="Return for correction" color={c.paper} ink={c.ink} style={{ alignSelf: 'flex-start' }} onPress={() => setAsking(true)} /> : null}
          {asking ? (
            <View style={{ gap: 8 }}>
              <T weight="800" size={13}>Which answers need fixing?</T>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                {[{ key: 'requested_cents', label: 'Amount requested' }, ...fields].map((f) => <Chip key={f.key} label={f.label} active={pick.includes(f.key)} onPress={() => setPick(pick.includes(f.key) ? pick.filter((x) => x !== f.key) : [...pick, f.key])} />)}
              </View>
              <Field label="What should the applicant change?" value={reason} onChangeText={setReason} multiline maxLength={1000} />
              <Btn title="Send back" disabled={!pick.length || !reason.trim()} onPress={send} />
            </View>
          ) : null}
        </>
      )}
    </Sheet>
  );
}

/** Invite athletes, teams or events to a program with search-and-pick controls; people who cannot be invited are listed with the reason. */
function InviteSheet({ visible, onClose, programId, onDone }) {
  const { toast } = useSession();
  const [kind, setKind] = useState('athlete');
  const [sel, setSel] = useState([]);
  const [message, setMessage] = useState('');
  const [skipped, setSkipped] = useState([]);
  const [busy, setBusy] = useState(false);
  const events = useLoad(() => (visible && kind === 'event' ? api.get('/events', { limit: 50 }) : Promise.resolve([])), [visible, kind]);
  const change = (k) => { setKind(k); setSel([]); setSkipped([]); };
  const send = async () => {
    setBusy(true);
    try {
      const r = await api.post(`/sponsorship-programs/${programId}/invitations`, { invitees: sel.map((x) => ({ target_type: kind, target_id: x.id })), message: message.trim() || undefined });
      setSkipped(r.skipped.map((x) => ({ ...x, label: sel.find((y) => y.id === x.target_id)?.label ?? x.target_id })));
      setSel(sel.filter((x) => r.skipped.some((y) => y.target_id === x.id)));
      toast(`${r.invited.length} invited${r.skipped.length ? `, ${r.skipped.length} could not be` : ''}`);
      onDone();
      if (!r.skipped.length) { setMessage(''); onClose(); }
    } catch (e) { toast(explain(e)); } finally { setBusy(false); }
  };
  return (
    <Sheet visible={visible} onClose={onClose} title="Invite to apply">
      <T size={13} color={c.mute}>Each invitee is notified. Athletes only appear if they opted in to sponsorship offers; people under the age of independence cannot be invited.</T>
      <Seg options={[{ value: 'athlete', label: 'Athletes' }, { value: 'team', label: 'Teams' }, { value: 'event', label: 'Events' }]} value={kind} onChange={change} color={c.violet} />
      {kind === 'team' ? <EntityPicker kind="team" label="Teams" value={sel} onChange={setSel} multi noun="team" />
        : kind === 'event' ? <EntityPicker kind="event" label="Events" value={sel} onChange={setSel} multi noun="event" options={(events.data ?? []).map((e) => ({ id: e.id, label: e.name, sub: e.city ?? '' }))} />
          : <EntityPicker label="Athletes" value={sel} onChange={setSel} multi role="athlete" noun="athlete" />}
      <Field label="Message (optional)" value={message} onChangeText={setMessage} multiline maxLength={1000} />
      {skipped.map((x) => <Banner key={x.target_id} tone={c.pinkSoft}>{x.label}: {x.reason}</Banner>)}
      <Btn title={busy ? 'Sending…' : `Invite ${sel.length || ''}`.trim()} disabled={!sel.length || busy} onPress={send} accessibilityLabel="Send invitations" />
    </Sheet>
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

/** The application form, shared by the opportunities list and the call page. `apply` is { program, round } or null. */
function ApplySheet({ apply, onClose, onDone }) {
  const { user } = useSession();
  const teams = useLoad(() => (apply ? api.get('/teams', { mine: true, limit: 50 }) : Promise.resolve([])), [!!apply]);
  const evs = useLoad(() => (apply ? api.get('/events', { organizer_id: user.id, limit: 50 }) : Promise.resolve([])), [!!apply]);
  const el = apply?.program.eligibility?.target_types ?? ['athlete', 'team', 'event'];
  const invited = apply?.program.visibility === 'invitation_only' ? (apply.program.invitations ?? []).filter((v) => ['invited', 'viewed'].includes(v.status)) : null;
  const allowed = (type, id) => !invited || invited.some((v) => v.target_type === type && v.target_id === id);
  const targets = [
    ...(el.includes('athlete') && allowed('athlete', user.id) ? [{ value: `athlete:${user.id}`, label: 'Myself (athlete)' }] : []),
    ...(el.includes('team') ? (teams.data ?? []).filter((t) => allowed('team', t.id)).map((t) => ({ value: `team:${t.id}`, label: `Team · ${t.name}` })) : []),
    ...(el.includes('event') ? (evs.data ?? []).filter((e) => allowed('event', e.id)).map((e) => ({ value: `event:${e.id}`, label: `Event · ${e.name}` })) : []),
  ];
  return (
    <FormSheet visible={!!apply} onClose={onClose} title={apply ? `Apply · ${apply.program.name}` : ''} submitLabel="Submit application"
      fields={[{ key: 'sec', type: 'section', label: apply ? `${apply.round.name} · closes ${deadline(apply.round.closes_at ?? apply.round.closes_on, apply.round.timezone)}${apply.program.max_award_cents ? ` · up to ${fmt(apply.program.max_award_cents, apply.program.currency)}` : ''}` : '' },
        { key: 'target', label: 'Applying for', type: 'choice', options: targets.length ? targets : [{ value: '', label: 'Nothing you own is eligible' }] },
        { key: 'requested_cents', label: 'Amount you are asking for', type: 'money', currency: apply?.program.currency },
        { key: 'pitch', label: 'Why should this be funded?', type: 'multiline', optional: true }]}
      onSubmit={async (v) => {
        const [target_type, target_id] = String(v.target ?? '').split(':');
        if (!target_id) throw new Error('Choose what you are applying for');
        await api.post(`/program-rounds/${apply.round.id}/applications`, { target_type, target_id, requested_cents: v.requested_cents, pitch: v.pitch });
        onDone(); return 'Application submitted — the terms you applied under are kept with it';
      }} />
  );
}

const Summary = ({ p }) => <T size={12} color={c.mute}>{[p.sports.length ? p.sports.join(', ') : 'Any sport', p.regions.length ? p.regions.join(', ') : 'Anywhere', (p.eligibility?.target_types ?? []).map((t) => TARGET_LABEL[t]).join(', '), p.eligibility?.verified_only ? 'Verified applicants only' : null].filter(Boolean).join(' · ')}</T>;

/** Applicants: search sponsorship calls, the ones I was invited to, and my applications. */
export function FundingOpportunities() {
  const { user, toast } = useSession();
  const { push } = useNav();
  const [q, setQ] = useState('');
  const [sport, setSport] = useState(null);
  const [region, setRegion] = useState('');
  const [sort, setSort] = useState('newest');
  const [tab, setTab] = useState('all'); // all | invited
  const [apply, setApply] = useState(null); // { program, round }
  const opps = useLoad(() => api.get('/funding-opportunities', { limit: 50, sort, ...(q.trim() ? { q: q.trim() } : {}), ...(sport ? { sport } : {}), ...(region ? { region } : {}), ...(tab === 'invited' ? { invited: true } : {}) }), [q, sport, region, sort, tab]);
  const mine = useLoad(() => api.get('/my/program-applications', { limit: 50 }), []);
  const reload = () => { opps.reload(); mine.reload(); };
  const act = async (fn, m) => { try { await fn(); toast(m); reload(); } catch (e) { toast(explain(e)); if (e.status === 409) reload(); } };
  const filtered = !!(q.trim() || sport || region);
  return (
    <Screen onRefresh={reload} refreshing={opps.loading && !!opps.data}>
      <H1>Sponsorship calls</H1>
      <T size={13} color={c.mute}>Sponsor programs with a round open for applications. Apply for yourself, a team you own or an event you organise. Invitation-only calls show here only if you were invited.</T>
      <Seg options={[{ value: 'all', label: 'Open calls' }, { value: 'invited', label: 'Invited to me' }]} value={tab} onChange={setTab} color={c.pink} />
      <Field value={q} onChangeText={setQ} placeholder="Search programs, sponsors and FAQs…" />
      <SportSelect value={sport} onChange={setSport} allLabel="All sports" />
      <RegionPicker label="Region" optional value={region} onChange={setRegion} />
      <Seg options={[{ value: 'newest', label: 'Newest' }, { value: 'closing_soon', label: 'Closing soon' }]} value={sort} onChange={setSort} color={c.violet} />
      {opps.error ? <LoadError error={opps.error} onRetry={opps.reload} /> : opps.loading && !opps.data ? <Loading /> : opps.data?.length ? opps.data.map((p) => (
        <Card key={p.id} onPress={() => push('SponsorCall', { id: p.id })} accessibilityLabel={`${p.name} by ${p.sponsor_name}. Open the call`}>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><T weight="900" style={{ flex: 1 }}>{p.name}</T>{p.visibility === 'invitation_only' ? <Tag label="Invited" color={c.violetSoft} /> : null}</View>
          <T size={12} color={c.mute}>{p.sponsor_name}{p.sponsor_verified?.length ? ' ✔ verified' : ''}{p.max_award_cents ? ` · up to ${fmt(p.max_award_cents, p.currency)}` : ''} · {p.currency}</T>
          {p.objective ? <T size={13} style={{ marginTop: 4 }} numberOfLines={3}>{p.objective}</T> : null}
          <Summary p={p} />
          {(p.rounds ?? []).map((r) => (
            <View key={r.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 }}>
              <T size={12} style={{ flex: 1 }}>{r.name} · closes {deadline(r.closes_at, r.timezone)}</T>
              <Btn small title="Apply" color={c.pink} onPress={() => setApply({ program: p, round: r })} accessibilityLabel={`Apply to ${p.name}, ${r.name}`} />
            </View>
          ))}
          {(p.invitations ?? []).filter((v) => ['invited', 'viewed'].includes(v.status)).map((v) => (
            <Btn key={v.id} small title="Decline invitation" color={c.paper} ink={c.red} style={{ alignSelf: 'flex-start', marginTop: 8 }} onPress={() => act(() => api.post(`/program-invitations/${v.id}/decline`), 'Invitation declined')} accessibilityLabel={`Decline the invitation to ${p.name}`} />
          ))}
        </Card>
      )) : <Empty emoji="🔎" title={tab === 'invited' ? 'No invitations right now' : filtered ? 'No open calls match your search' : 'No open calls right now'} sub={tab === 'invited' ? 'When a sponsor invites you to apply, it appears here and in your notifications.' : filtered ? 'Try fewer filters.' : 'Check back later — calls appear here while a round is open.'} />}
      <Section title="My applications" color={c.mint}>
        {mine.error ? <LoadError error={mine.error} onRetry={mine.reload} /> : mine.loading && !mine.data ? <Loading /> : mine.data?.length ? mine.data.map((a) => (
          <Card key={a.id}>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><View style={{ flex: 1 }}><T weight="900">{a.program_name} · {a.round_name}</T><T size={12} color={c.mute}>{a.sponsor_name} · for {a.target_name ?? a.target_type} · {a.requested_cents != null ? `asked ${fmt(a.requested_cents, a.currency)}` : 'no amount yet'}{a.awarded_cents ? ` · awarded ${fmt(a.awarded_cents, a.currency)}` : ''}</T></View><Tag label={a.status} color={STATUS_TONE[a.status]} /></View>
            <T size={12} color={c.mute}>{a.receipt_no ? `Receipt ${a.receipt_no} · ` : ''}{a.form_version ? `form v${a.form_version} · ` : ''}Made under round terms v{a.round_terms_version}, closing {when(a.terms_snapshot?.round?.closes_on)}.</T>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><View style={{ flex: 1 }}><T weight="900">{a.program_name} · {a.round_name}</T><T size={12} color={c.mute}>{a.sponsor_name} · for {a.target_name ?? a.target_type} · asked {fmt(a.requested_cents, a.currency)}{a.awarded_cents ? ` · awarded ${fmt(a.awarded_cents, a.currency)}` : ''}</T></View><Tag label={a.status} color={STATUS_TONE[a.status]} /></View>
            <T size={12} color={c.mute}>Made under round terms v{a.round_terms_version}, closing {deadline(a.terms_snapshot?.round?.closes_at ?? a.terms_snapshot?.round?.closes_on, a.terms_snapshot?.round?.timezone)}.</T>
            {a.decision_reason ? <T size={12}>Note: {a.decision_reason}</T> : null}
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
              {a.form_id && ['draft', 'returned'].includes(a.status) ? <Btn small title={a.status === 'draft' ? 'Resume draft' : 'Fix and resend'} color={c.pink} onPress={() => push('ApplicationForm', { round_id: a.round_id, target_type: a.target_type, target_id: a.target_id })} /> : null}
              {a.form_id && !['draft', 'returned'].includes(a.status) ? <Btn small title="View receipt" color={c.violet} onPress={() => push('ApplicationForm', { round_id: a.round_id, target_type: a.target_type, target_id: a.target_id })} /> : null}
              {['draft', 'submitted', 'returned'].includes(a.status) ? <Btn small title="Withdraw" color={c.paper} ink={c.red} onPress={() => act(() => api.post(`/program-applications/${a.id}/withdraw`), 'Application withdrawn')} /> : null}
              {a.sponsorship_id ? <Btn small title="Open agreement" color={c.violet} onPress={() => push('SponsorDeal', { id: a.sponsorship_id })} /> : null}
            </View>
          </Card>
        )) : <Empty emoji="✉️" title="No applications yet" />}
      </Section>
      <FormSheet visible={!!apply} onClose={() => setApply(null)} title={apply ? `Apply · ${apply.program.name}` : ''} submitLabel={apply?.round.has_form ? 'Continue to the form' : 'Submit application'}
        fields={[{ key: 'sec', type: 'section', label: apply ? `${apply.round.name} · closes ${when(apply.round.closes_on)}${apply.program.max_award_cents ? ` · up to ${fmt(apply.program.max_award_cents, apply.program.currency)}` : ''}` : '' },
          { key: 'target', label: 'Applying for', type: 'choice', options: targets.length ? targets : [{ value: '', label: 'Nothing you own is eligible' }] },
          ...(apply?.round.has_form ? [] : [{ key: 'requested_cents', label: 'Amount you are asking for', type: 'money', currency: apply?.program.currency },
            { key: 'pitch', label: 'Why should this be funded?', type: 'multiline', optional: true }])]}
        onSubmit={async (v) => {
          const [target_type, target_id] = String(v.target ?? '').split(':');
          if (!target_id) throw new Error('Choose what you are applying for');
          if (apply.round.has_form) { push('ApplicationForm', { round_id: apply.round.id, target_type, target_id }); return undefined; }
          await api.post(`/program-rounds/${apply.round.id}/applications`, { target_type, target_id, requested_cents: v.requested_cents, pitch: v.pitch }); reload(); return 'Application submitted — the terms you applied under are kept with it';
        }} />
      <ApplySheet apply={apply} onClose={() => setApply(null)} onDone={reload} />
    </Screen>
  );
}

/** One sponsorship call's page: sponsor, terms, rounds with deadlines in their timezone, FAQs, and how to apply. */
export function SponsorCall({ id }) {
  const { user, toast } = useSession();
  const { push } = useNav();
  const [apply, setApply] = useState(null);
  const [open, setOpen] = useState(null); // FAQ id
  const call = useLoad(() => api.get(`/funding-opportunities/${id}`), [id]);
  const p = call.data;
  if (call.loading && !p) return <Screen><Loading /></Screen>;
  if (call.error) return <Screen><LoadError error={call.error} onRetry={call.reload} /></Screen>;
  const openRounds = (p.rounds ?? []).filter((r) => r.state === 'open');
  const closed = !openRounds.length;
  const pending = (p.invitations ?? []).filter((v) => ['invited', 'viewed'].includes(v.status));
  return (
    <Screen onRefresh={call.reload} refreshing={call.loading && !!p}>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><H1 style={{ flex: 1 }}>{p.name}</H1><Tag label={VISIBILITY_LABEL[p.visibility]} color={p.visibility === 'public' ? c.lime : c.violetSoft} /></View>
      <T size={12} color={c.mute}>{p.sponsor_name}{p.sponsor_verified?.length ? ' ✔ verified' : ''}{p.max_award_cents ? ` · up to ${fmt(p.max_award_cents, p.currency)} per award` : ''} · {p.currency}</T>
      {closed ? <Banner tone={c.pinkSoft}>{p.status === 'published' ? 'This call is not open right now. Applications are not accepted until a round opens.' : 'This call has closed and no longer accepts applications.'}</Banner> : null}
      {p.i_am_staff ? <Banner action="Manage" onAction={() => push('SponsorProgram', { id: p.id })}>You run this brand. This is how applicants see the call.</Banner> : null}
      {pending.map((v) => <Banner key={v.id} tone={c.sunSoft} action="Decline" onAction={async () => { try { await api.post(`/program-invitations/${v.id}/decline`); toast('Invitation declined'); call.reload(); } catch (e) { toast(explain(e)); call.reload(); } }}>You were invited to apply{v.message ? `: “${v.message}”` : '.'}</Banner>)}
      <Card>
        {p.objective ? <T size={14}>{p.objective}</T> : <T size={13} color={c.mute}>No description yet.</T>}
        <Summary p={p} />
      </Card>
      <Section title="Rounds and deadlines" color={c.sun}>
        {(p.rounds ?? []).length ? p.rounds.map((r) => (
          <Card key={r.id} color={c.sunSoft}>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><T weight="900" style={{ flex: 1 }}>{r.name}</T><Tag label={r.state} color={STATUS_TONE[r.state]} /></View>
            <T size={12} color={c.mute}>{r.state === 'scheduled' ? `Opens ${deadline(r.opens_at, r.timezone)} · ` : ''}{r.state === 'closed' ? 'Closed' : 'Closes'} {deadline(r.closes_at, r.timezone)}</T>
            {r.state === 'open' && p.can_apply ? <Btn small title="Apply" color={c.pink} style={{ alignSelf: 'flex-start', marginTop: 8 }} onPress={() => setApply({ program: p, round: r })} accessibilityLabel={`Apply to ${p.name}, ${r.name}`} /> : null}
          </Card>
        )) : <Empty emoji="🗓️" title="No rounds yet" />}
        {!user ? <T size={12} color={c.mute}>Sign in to apply.</T> : null}
      </Section>
      <Section title="FAQs" color={c.mint}>
        {p.faqs?.length ? p.faqs.map((f) => (
          <Card key={f.id} onPress={() => setOpen(open === f.id ? null : f.id)} accessibilityLabel={`${f.question}. ${open === f.id ? 'Collapse' : 'Expand'} answer`}>
            <T weight="900">{open === f.id ? '▾ ' : '▸ '}{f.question}</T>
            {open === f.id ? <T size={13} style={{ marginTop: 6 }}>{f.answer}</T> : null}
          </Card>
        )) : <Empty emoji="❓" title="No FAQs yet" />}
      </Section>
      <ApplySheet apply={apply} onClose={() => setApply(null)} onDone={call.reload} />
    </Screen>
  );
}
