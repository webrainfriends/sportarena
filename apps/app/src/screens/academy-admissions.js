// Admissions: the pipeline as a board (one column per stage group) or a table, with the full application review in a side panel.
import React, { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Chip, Empty, ErrorBox, Field, Loading, Row, Seg, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c } from '../theme';
import { moneyIn } from '../vtime';
import { explain } from '../access';
import { useLayout } from '../layout';
import { Block, Fact, Initials, Split, StageBadge, StageTrack, Timeline, STAGE, ago, hoursLeft, when } from './academy-ui';

const COLUMNS = [
  ['New', ['enquiry'], 'Fresh enquiries to answer'],
  ['Trial', ['trial_requested', 'trial_booked', 'trial_completed'], 'Trials to book or finish'],
  ['Applying', ['application_draft', 'submitted', 'under_review'], 'Applications to review'],
  ['Offered', ['offered', 'offer_accepted'], 'Waiting on the family'],
  ['Waitlist', ['waitlisted'], 'In order of joining'],
  ['Enrolled', ['enrolled'], 'Places taken'],
];
const CLOSED = ['declined', 'withdrawn', 'expired', 'cancelled'];

export function Admissions({ o, archived, toast, openId, setOpenId }) {
  const [view, setView] = useState('board');
  const [programme, setProgramme] = useState(null);
  const [q, setQ] = useState('');
  const [closed, setClosed] = useState(false);
  const progs = useLoad(() => api.get(`/organisations/${o.id}/academy/programmes`, { limit: 100 }), [o.id]);
  const list = useLoad(() => api.get(`/organisations/${o.id}/academy/applications`, { programme_id: programme || undefined, q: q.trim() || undefined, limit: 100 }), [o.id, programme, q]);
  const [open, setOpen] = useState(openId ?? null);
  const sel = (id) => { setOpen(id); setOpenId?.(id); };
  const apps = (list.data ?? []).filter((a) => closed || !CLOSED.includes(a.stage));
  const body = (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <View style={{ minWidth: 190 }}><Seg value={view} onChange={setView} color={c.violet} options={[{ value: 'board', label: 'Board' }, { value: 'table', label: 'Table' }]} /></View>
        <View style={{ flex: 1, minWidth: 200 }}><Field value={q} onChangeText={setQ} placeholder="Search athlete name or handle…" accessibilityLabel="Search applications" /></View>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
        <Chip label="All programmes" active={!programme} onPress={() => setProgramme(null)} />
        {(progs.data ?? []).filter((p) => p.status !== 'archived').map((p) => <Chip key={p.id} label={p.title} active={programme === p.id} onPress={() => setProgramme(p.id)} />)}
        <Chip label={closed ? 'Hiding nothing' : 'Hide closed'} active={!closed} onPress={() => setClosed(!closed)} />
      </ScrollView>
      {list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !list.data ? <Loading /> : !apps.length ? (
        <Empty emoji="📥" title="No applications yet" sub="When families enquire, request a trial or apply, they appear here. Publish a programme to start." />
      ) : view === 'board' ? <Board apps={apps} open={open} onOpen={sel} /> : <Table apps={apps} open={open} onOpen={sel} />}
    </View>
  );
  return (
    <Split open={!!open} onClose={() => sel(null)} detailTitle="Application" list={body}
      detail={open ? <Review id={open} archived={archived} toast={toast} onChanged={list.reload} onClose={() => sel(null)} onOpenAthlete={null} /> : null} />
  );
}

function Card({ a, on, onOpen }) {
  const hot = a.stage === 'offered' && a.offer_expires_at && new Date(a.offer_expires_at) - Date.now() < 48 * 3600e3;
  return (
    <Pressable onPress={() => onOpen(a.id)} accessibilityRole="button" accessibilityLabel={`${a.display_name}, ${a.programme}, ${STAGE[a.stage]}, ${ago(a.days_in_stage)} in this stage`}
      style={{ backgroundColor: c.paper, borderRadius: 16, padding: 12, gap: 6, borderWidth: on ? 2 : 1, borderColor: on ? c.pink : c.line }}>
      <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
        <Initials user={a} size={34} />
        <View style={{ flex: 1 }}><T weight="800" size={14}>{a.display_name}</T><T size={12} color={c.mute}>{a.programme}</T></View>
      </View>
      {a.via_guardian ? <T size={12} color={c.mute}>Applied by {a.applicant_name}</T> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4 }}>
        <Tag label={a.days_in_stage <= 0 ? 'New today' : `${ago(a.days_in_stage)} in stage`} color={a.days_in_stage >= 7 ? c.orangeSoft : undefined} />
        {hot ? <Tag label={`⏰ ${hoursLeft(a.offer_expires_at)}`} color={c.orangeSoft} /> : null}
        {a.unpaid_charges ? <Tag label={`${a.unpaid_charges} unpaid`} color={c.sunSoft} /> : null}
        {a.waitlist_seq && a.stage === 'waitlisted' ? <Tag label="Waiting" /> : null}
        {(a.tags ?? []).map((t) => <Tag key={t} label={`#${t}`} />)}
      </View>
      {a.next_action ? <T size={12} weight="700" color={a.next_action_on && a.next_action_on.slice(0, 10) <= new Date().toISOString().slice(0, 10) ? c.red : c.mute}>↪ {a.next_action}{a.next_action_on ? ` · ${when(a.next_action_on)}` : ''}</T> : null}
      {a.assignee_name ? <T size={11} color={c.mute}>Owner: {a.assignee_name}</T> : null}
    </Pressable>
  );
}

function Board({ apps, open, onOpen }) {
  const { tablet } = useLayout();
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={{ gap: 12, paddingBottom: 8 }}>
      {COLUMNS.map(([title, stages, help]) => {
        const col = apps.filter((a) => stages.includes(a.stage));
        return (
          <View key={title} style={{ width: tablet ? 250 : 270, gap: 8 }} accessibilityLabel={`${title}, ${col.length} applications`}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}><T weight="800" size={14}>{title}</T><Tag label={String(col.length)} /></View>
            <T size={11} color={c.mute}>{help}</T>
            {col.length ? col.map((a) => <Card key={a.id} a={a} on={open === a.id} onOpen={onOpen} />) : <View style={{ padding: 14, borderRadius: 14, borderWidth: 1, borderStyle: 'dashed', borderColor: c.line }}><T size={12} color={c.mute}>Nothing here</T></View>}
          </View>
        );
      })}
    </ScrollView>
  );
}

function Table({ apps, open, onOpen }) {
  const { tablet } = useLayout();
  return (
    <View style={{ gap: 6 }}>
      {tablet ? (
        <View style={{ flexDirection: 'row', paddingHorizontal: 12, gap: 8 }}>
          {[['Athlete', 3], ['Programme', 3], ['Stage', 2], ['In stage', 1], ['Next action', 3]].map(([h, f]) => <T key={h} size={11} weight="800" color={c.mute} style={{ flex: f, letterSpacing: 0.8 }}>{h.toUpperCase()}</T>)}
        </View>
      ) : null}
      {apps.map((a) => tablet ? (
        <Pressable key={a.id} onPress={() => onOpen(a.id)} accessibilityRole="button" accessibilityLabel={`${a.display_name}, ${a.programme}, ${STAGE[a.stage]}`} style={{ flexDirection: 'row', gap: 8, alignItems: 'center', padding: 12, borderRadius: 14, backgroundColor: c.paper, borderWidth: open === a.id ? 2 : 1, borderColor: open === a.id ? c.pink : c.line }}>
          <View style={{ flex: 3, flexDirection: 'row', gap: 8, alignItems: 'center' }}><Initials user={a} size={30} /><View style={{ flex: 1 }}><T weight="700" size={14}>{a.display_name}</T>{a.via_guardian ? <T size={11} color={c.mute}>via {a.applicant_name}</T> : null}</View></View>
          <T size={13} style={{ flex: 3 }}>{a.programme}</T>
          <View style={{ flex: 2, alignItems: 'flex-start' }}><StageBadge stage={a.stage} /></View>
          <T size={13} style={{ flex: 1 }}>{ago(a.days_in_stage)}</T>
          <T size={13} color={c.mute} style={{ flex: 3 }}>{a.next_action ?? '—'}</T>
        </Pressable>
      ) : <Card key={a.id} a={a} on={open === a.id} onOpen={onOpen} />)}
    </View>
  );
}

/** The review panel: everything staff need to decide, in one place. */
export function Review({ id, archived, toast, onChanged, onClose }) {
  const app = useLoad(() => api.get(`/academy/applications/${id}`), [id]);
  const desk = useLoad(() => (app.data ? api.get(`/academy/programmes/${app.data.programme_id}`) : Promise.resolve(null)), [app.data?.programme_id]);
  const bill = useLoad(() => (app.data ? api.get(`/academy/programmes/${app.data.programme_id}/agreements`, { athlete_id: app.data.athlete_id }).catch(() => []) : Promise.resolve([])), [app.data?.athlete_id, app.data?.programme_id]);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  if (app.error) return <ErrorBox error={app.error} onRetry={app.reload} />;
  const a = app.data;
  if (!a) return <Loading />;
  const after = () => { app.reload(); onChanged?.(); };
  const act = async (fn, msg) => { setBusy(true); try { await fn(); toast(msg); } catch (e) { toast(explain(e)); } finally { setBusy(false); after(); } };
  const decide = (decision, reason) => act(() => api.post(`/academy/applications/${id}/decision`, { row_version: a.row_version, decision, reason }), decision === 'offer' ? 'Offer sent' : decision === 'waitlist' ? 'Added to the waitlist' : decision === 'review' ? 'Review started' : 'Declined');
  const trial = (step) => act(() => api.post(`/academy/applications/${id}/trial/advance`, { row_version: a.row_version, step }), step === 'book' ? 'Trial booked' : 'Trial completed');
  const live = !['declined', 'withdrawn', 'expired', 'cancelled', 'enrolled'].includes(a.stage);
  const can = (...s) => s.includes(a.stage) && !archived;
  const seats = desk.data;
  const full = seats?.capacity && seats.seats_taken >= seats.capacity;
  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
        <Initials user={a.athlete} size={44} />
        <View style={{ flex: 1 }}><T weight="800" size={17}>{a.athlete?.display_name}</T><T size={12} color={c.mute}>@{a.athlete?.handle}{a.applicant_id !== a.athlete_id ? ` · applied by ${a.applicant?.display_name} (guardian)` : ''}</T></View>
        <StageBadge stage={a.stage} />
      </View>
      <StageTrack stage={a.stage} />
      <Block title="Application">
        <Fact k="Programme" v={desk.data?.title ?? '…'} />
        <Fact k="Seats" v={seats ? (seats.capacity ? `${seats.seats_taken}/${seats.capacity} taken${seats.waitlisted ? ` · ${seats.waitlisted} waiting` : ''}` : 'No limit') : null} />
        <Fact k="Price" v={seats?.version ? (seats.version.billing_model === 'free' ? 'Free' : moneyIn(seats.version.fee_minor, seats.version.currency)) : null} />
        <Fact k="Started" v={when(a.created_at)} />
        {a.stage === 'offered' && a.offer_expires_at ? <Fact k="Offer ends" v={`${when(a.offer_expires_at)} · ${hoursLeft(a.offer_expires_at)}`} /> : null}
        {a.waitlist_position ? <Fact k="Waitlist place" v={`#${a.waitlist_position}`} /> : null}
        {a.decision_reason ? <Fact k="Decision note" v={a.decision_reason} /> : null}
      </Block>
      {can('submitted', 'under_review', 'waitlisted', 'trial_requested', 'trial_booked') ? (
        <Block title="Decide">
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {a.stage === 'trial_requested' ? <Btn small title="Book the trial" onPress={() => trial('book')} loading={busy} /> : null}
            {a.stage === 'trial_booked' ? <Btn small title="Mark trial completed" onPress={() => trial('complete')} loading={busy} /> : null}
            {a.stage === 'submitted' ? <Btn small title="Start review" color={c.paper} ink={c.ink} onPress={() => decide('review')} loading={busy} /> : null}
            {['submitted', 'under_review', 'waitlisted'].includes(a.stage) ? <Btn small title="Offer a place" onPress={() => decide('offer')} loading={busy} disabled={full && a.stage !== 'waitlisted'} /> : null}
            {['submitted', 'under_review'].includes(a.stage) ? <Btn small title="Waitlist" color={c.paper} ink={c.ink} onPress={() => decide('waitlist')} loading={busy} /> : null}
            {['submitted', 'under_review', 'waitlisted'].includes(a.stage) ? <Btn small title="Decline…" color={c.orange} onPress={() => setForm('decline')} /> : null}
          </View>
          {full && ['submitted', 'under_review'].includes(a.stage) ? <T size={12} color={c.mute}>The programme is full: waitlist this applicant, or raise the capacity first.</T> : null}
        </Block>
      ) : null}
      {Object.keys(a.answers ?? {}).length ? (
        <Block title="Their answers">
          {Object.entries(a.answers).map(([k, v]) => <View key={k} style={{ gap: 2 }}><T size={11} weight="800" color={c.mute}>{k.replace(/_/g, ' ').toUpperCase()}</T><T size={14}>{String(v)}</T></View>)}
        </Block>
      ) : null}
      <Block title="Agreements">
        {!bill.data ? <Loading /> : bill.data.length ? bill.data.map((g) => <T key={g.version_id} size={13}>⚠️ {g.title} (v{g.version}) not yet acknowledged</T>) : <T size={13} color={c.mute}>✓ Nothing outstanding for this programme.</T>}
      </Block>
      <Block title="Follow-up" right={live && !archived ? <Btn small title="Edit" color={c.paper} ink={c.ink} onPress={() => setForm('crm')} /> : null}>
        <Fact k="Owner" v={a.assignee_name ?? 'Unassigned'} />
        <Fact k="Next action" v={a.next_action ? `${a.next_action}${a.next_action_on ? ` · ${when(a.next_action_on)}` : ''}` : 'None set'} />
        {a.tags?.length ? <View style={{ flexDirection: 'row', gap: 4, flexWrap: 'wrap' }}>{a.tags.map((t) => <Tag key={t} label={`#${t}`} />)}</View> : null}
      </Block>
      <Block title="Internal notes" right={!archived ? <Btn small title="Add note" color={c.paper} ink={c.ink} onPress={() => setForm('note')} /> : null}>
        <T size={11} color={c.mute}>Only academy staff see these. They are never sent to the family.</T>
        {a.notes?.length ? a.notes.map((n) => <View key={n.id} style={{ padding: 10, borderRadius: 12, backgroundColor: c.sunSoft }}><T size={13}>{n.body}</T><T size={11} color={c.mute}>{when(n.created_at)}</T></View>) : <T size={13} color={c.mute}>No notes yet.</T>}
      </Block>
      <Block title="History">
        <Timeline items={a.history.map((h) => ({ title: `${h.from_stage ? `${STAGE[h.from_stage]} → ` : ''}${STAGE[h.to_stage]}`, sub: `${when(h.created_at)}${h.reason ? ` · ${h.reason}` : ''}` }))} />
      </Block>
      <FormSheet visible={form === 'decline'} onClose={() => setForm(null)} title="Decline application" submitLabel="Decline"
        fields={[{ key: 'reason', label: 'Reason (kept in the history, not sent word for word)', type: 'multiline' }]}
        onSubmit={async (v) => { await api.post(`/academy/applications/${id}/decision`, { row_version: a.row_version, decision: 'decline', reason: v.reason }); after(); return 'Declined'; }} />
      <FormSheet visible={form === 'note'} onClose={() => setForm(null)} title="Internal note" submitLabel="Save note" fields={[{ key: 'body', label: 'Note', type: 'multiline' }]}
        onSubmit={async (v) => { await api.post(`/academy/applications/${id}/notes`, v); after(); return 'Note saved'; }} />
      <FormSheet visible={form === 'crm'} onClose={() => setForm(null)} title="Follow-up" initial={{ next_action: a.next_action ?? '', next_action_on: a.next_action_on?.slice(0, 10), tags: a.tags ?? [] }}
        fields={[{ key: 'next_action', label: 'What needs doing', optional: true }, { key: 'next_action_on', label: 'By', type: 'date', optional: true }, { key: 'tags', label: 'Tags', type: 'multi', optional: true, options: ['hot', 'sibling', 'scholarship', 'call-back', 'referral'] }]}
        onSubmit={async (v) => { await api.patch(`/academy/applications/${id}/crm`, v); after(); return 'Saved'; }} />
    </View>
  );
}
