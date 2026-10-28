// Representation (#484): one screen, two doors. "My representation" is the athlete's view (agent, permissions, activity, approvals, commission,
// revoke / renew); "Agent home" is the agent's workspace. A guardian opens the athlete door for a young person with athlete_id. Logic lives in the
// representation capabilities (REST + OpenAPI + MCP); this only calls them.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, ErrorBox, Field, GradCard, H1, Loading, Row, Screen, Section, Sheet, T, Tag } from '../ui';
import { HScroll } from '../pickers';
import { SportPicker } from '../sportpicker';
import { c } from '../theme';
import { useLayout } from '../layout';
import { Ladder, LiveTag, Note, Pills, Split, StatusTag, TermsSheet, cash, key, nice, plainDate, say, when } from '../representation-ui';
import { MandateDetail } from './representation-mandate';
import { AgentHome } from './representation-agent';

export function Representation({ athlete_id, name, door: want, tab: wantTab }) {
  const { user } = useSession();
  const me = useLoad(() => api.get('/agents/me'), []);
  const isAgent = !!(user?.roles?.includes('agent') || me.data?.profile || me.data?.works_for?.length);
  const [door, setDoor] = useState(want ?? null);
  if (me.loading && !me.data) return <Screen><Loading /></Screen>;
  const active = door ?? (isAgent && !athlete_id ? 'agent' : 'athlete');
  return (
    <Screen wide>
      <GradCard>
        <T size={12} weight="800" color="rgba(255,255,255,0.8)">REPRESENTATION</T>
        <H1 color="#fff">{athlete_id ? `For ${name ?? 'your child'}` : active === 'agent' ? 'Agent home' : 'My representation'}</H1>
        <T color="rgba(255,255,255,0.9)" size={14} style={{ marginTop: 4 }}>You decide who represents you, what they can see and do, and you can stop it at any moment. Accepting a position or offer and signing always stay with the athlete{athlete_id ? ' and a guardian' : ''}.</T>
      </GradCard>
      {isAgent && !athlete_id ? <View style={{ marginTop: 12 }}><Pills items={[['athlete', 'My representation'], ['agent', 'Agent home']]} active={active} onChange={setDoor} /></View> : null}
      <View style={{ marginTop: 16 }}>{active === 'agent' ? <AgentHome profile={me.data} reloadProfile={me.reload} tab={wantTab} /> : <AthleteView athleteId={athlete_id} />}</View>
    </Screen>
  );
}

const ATABS = [['mine', 'Representation'], ['approvals', 'Approvals'], ['activity', 'Agent activity'], ['commission', 'Commission']];

function AthleteView({ athleteId }) {
  const { toast } = useSession();
  const q = useLoad(() => api.get('/me/representation', athleteId ? { athlete_id: athleteId } : undefined), [athleteId]);
  const [tab, setTab] = useState('mine');
  const [sel0, setSel] = useState(null);
  const [find, setFind] = useState(false);
  const L = useLayout();
  if (q.loading && !q.data) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={q.reload} />;
  const d = q.data;
  const open = d.mandates.filter((m) => ['active', 'proposed', 'draft'].includes(m.status) || m.status === 'expired');
  const waiting = d.mandates.filter((m) => m.needs_my_signature).length;
  // on a wide screen the list sits beside the detail, so open the most pressing one: needs a signature, then in force, then the newest
  const first = d.mandates.find((m) => m.needs_my_signature) ?? d.mandates.find((m) => m.live) ?? d.mandates[0];
  const sel = sel0 ?? (L.width >= 900 ? first?.id : null);
  const decideAllowed = ['athlete', 'guardian'].includes(d.side);

  const list = (
    <>
      {waiting ? <Note>{waiting} representation{waiting === 1 ? ' needs' : 's need'} your signature.</Note> : null}
      {d.conflicts.length ? <Note tone={c.pinkSoft}>{d.conflicts.length} possible conflict{d.conflicts.length === 1 ? '' : 's'} of interest to decide.</Note> : null}
      {d.mandates.length ? d.mandates.map((m) => (
        <Row key={m.id} title={m.agent.display_name} sub={`${m.mandate_no} · ${m.sports.map((s) => s.name).join(', ') || 'No sports yet'}${m.ends_on ? ` · until ${plainDate(m.ends_on)}` : ''}`} onPress={() => { setSel(m.id); }}
          right={<View style={{ alignItems: 'flex-end', gap: 4 }}><LiveTag m={m} />{m.needs_my_signature ? <Tag label="Needs your signature" color={c.sun} /> : null}{m.pending_approvals ? <Tag label={`${m.pending_approvals} to approve`} color={c.sun} /> : null}</View>} />
      )) : null}
      {decideAllowed ? <Btn small title="Find an agent" onPress={() => setFind(true)} style={{ alignSelf: 'flex-start' }} /> : null}
    </>
  );

  return (
    <View style={{ gap: 14 }}>
      <HScroll>{ATABS.map(([k, l]) => <Chip key={k} label={`${l}${k === 'approvals' && d.approvals.length ? ` (${d.approvals.length})` : ''}`} active={tab === k} onPress={() => { setTab(k); setSel(null); }} />)}</HScroll>
      {tab === 'mine' ? (
        d.mandates.length || decideAllowed ? (
          <Split list={list} selected={sel} emptyTitle="Pick a representation" emptySub="What the agent can see and do, what you shared, commission and history open here."
            detail={<MandateDetail key={sel} id={sel} onBack={() => setSel(null)} onChanged={q.reload} />} />
        ) : <Empty emoji="🤝" title="No representation" sub="Only the athlete, or a guardian for a young person, can start one." />
      ) : null}
      {tab === 'approvals' ? <Approvals d={d} reload={q.reload} decideAllowed={decideAllowed} toast={toast} /> : null}
      {tab === 'activity' ? <Activity d={d} /> : null}
      {tab === 'commission' ? <CommissionSummary d={d} /> : null}
      <FindAgent visible={find} onClose={() => setFind(false)} athleteId={athleteId} onDone={(m) => { setFind(false); q.reload(); setTab('mine'); setSel(m.id); }} />
    </View>
  );
}

function Approvals({ d, reload, decideAllowed, toast }) {
  const decide = async (a, decision) => { try { await api.post(`/representation/approvals/${a.id}/decision`, { decision }); toast(decision === 'approve' ? 'Approved' : 'Declined'); reload(); } catch (e) { toast(say(e)); } };
  if (!d.approvals.length) return <Empty emoji="✅" title="Nothing waiting" sub="When your agent asks to express interest or send an application for you, it appears here. Nothing is sent without you." />;
  return (
    <View style={{ gap: 10 }}>
      {d.approvals.map((a) => (
        <Card key={a.id}>
          <T weight="800">{a.kind === 'submit_application' ? 'Send an application as you' : 'Tell the poster you are interested'}</T>
          <T style={{ marginTop: 4 }}>{a.summary}</T>
          <T size={12} color={c.mute} style={{ marginTop: 4 }}>Asked by {a.requested_by_name} · expires {when(a.expires_at)}</T>
          {decideAllowed ? <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}><Btn small title="Approve" onPress={() => decide(a, 'approve')} /><Btn small title="Decline" color={c.paper} ink={c.ink} onPress={() => decide(a, 'decline')} /></View> : <T size={12} color={c.mute} style={{ marginTop: 8 }}>A guardian approves this.</T>}
        </Card>
      ))}
    </View>
  );
}

function Activity({ d }) {
  if (!d.activity.length) return <Empty emoji="🕘" title="No agent activity" sub="What your agent and the platform do under a mandate is listed here, newest first." />;
  return <View style={{ gap: 8 }}>{d.activity.map((e) => <Row key={e.seq} title={nice(e.action).replace(/^./, (x) => x.toUpperCase())} sub={`${e.actor ?? 'The platform'} · ${nice(e.actor_side)} · ${when(e.created_at)}`} />)}</View>;
}

function CommissionSummary({ d }) {
  const cur = Object.entries(d.commission);
  if (!cur.length) return <Empty emoji="🧾" title="No commission" sub="Commission appears only for deals you confirmed. It is calculated from the deal's own record, never from anything else you earn." />;
  return (
    <View style={{ gap: 10 }}>
      {cur.map(([currency, l]) => (
        <Card key={currency}><T weight="800" style={{ marginBottom: 8 }}>{currency}</T><Ladder ladder={l} currency={currency} /></Card>
      ))}
      <T size={12} color={c.mute}>Open a representation to see each deal, its statements and to report a payment.</T>
    </View>
  );
}

// ------------------------------------------------------------------ finding an agent
function FindAgent({ visible, onClose, athleteId, onDone }) {
  const { toast } = useSession();
  const [qText, setQText] = useState('');
  const [sport, setSport] = useState(null);
  const sports = useLoad(() => api.get('/sports'), []);
  const sportId = sports.data?.find((s) => s.slug === sport)?.id;
  const found = useLoad(() => (visible ? api.get('/agents', { q: qText.trim() || undefined, sport_id: sportId, limit: 20 }) : Promise.resolve([])), [visible, qText, sportId]);
  const [pick, setPick] = useState(null);
  const [form, setForm] = useState(false);
  return (
    <>
      <Sheet visible={visible && !form} onClose={onClose} title="Find an agent">
        <Note tone={c.violetSoft}>Listed agents are verified by SportArena, and the profile says what was checked. Being listed is not an endorsement and gives no access to anything: only a mandate you agree does.</Note>
        <Field value={qText} onChangeText={setQText} placeholder="Search by name" />
        <SportPicker label="Sport" optional value={sport} onChange={setSport} />
        {found.loading ? <Loading /> : found.data?.length ? found.data.map((a) => (
          <Card key={a.id} onPress={() => setPick(pick?.id === a.id ? null : a)}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <View style={{ flex: 1, minWidth: 160 }}><T weight="800">{a.display_name}</T><T size={12} color={c.mute}>{a.kind === 'agency' ? 'Agency' : 'Individual'} · {a.sports.map((s) => s.name).join(', ') || 'Any sport'} · {a.markets.join(', ') || '—'}</T></View>
              <Tag label="Verified" color={c.mint} />
            </View>
            {pick?.id === a.id ? (
              <View style={{ marginTop: 10, gap: 6 }}>
                {a.bio ? <T size={13}>{a.bio}</T> : null}
                <T weight="800" size={13}>What was checked</T>
                {a.verification.checked.map((x) => <T key={x.label} size={13}>✓ {x.label}{x.note ? ` - ${x.note}` : ''}</T>)}
                <T size={12} color={c.mute}>{a.verification.statement}</T>
                {a.licences.length ? a.licences.map((l) => <T key={l.id} size={13}>{l.issuing_body} · {l.grade || 'Registration'} · {l.jurisdiction} - {l.standing}{l.valid_to ? ` until ${plainDate(l.valid_to)}` : ''}</T>) : <T size={13} color={c.mute}>No licence declared.</T>}
                <Btn small title="Propose a mandate" onPress={() => setForm(true)} style={{ alignSelf: 'flex-start', marginTop: 4 }} />
              </View>) : <T size={12} color={c.pink} weight="700" style={{ marginTop: 6 }}>Tap to see what was checked</T>}
          </Card>
        )) : <Empty emoji="🔎" title="No listed agents match" sub="Try another name or sport." />}
      </Sheet>
      {form && pick ? (
        <TermsSheet visible onClose={() => setForm(false)} title={`A mandate with ${pick.display_name}`} submitLabel="Send for signature" agent={{ licences: pick.licences, kind: pick.kind, young: !!athleteId }}
          notice="You can change what they see, share items one by one, and revoke at any moment. Nothing is shared until you both sign."
          onSubmit={async (terms) => {
            const m = await api.post('/representation/mandates', { agent_id: pick.id, athlete_id: athleteId || undefined, terms, send: true, client_key: key() });
            setForm(false); toast('Sent to the agent to sign'); onDone(m);
          }} />
      ) : null}
    </>
  );
}
export { StatusTag, cash };
