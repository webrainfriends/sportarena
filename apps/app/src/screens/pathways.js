// Learn and study sport: the rules of a sport, programmes and institutions that teach it, the enquiry conversation (shared with the
// institution's admissions team), and the certificates and badges an athlete earns and shows on their profile.
import React, { useState } from 'react';
import { Linking, Platform, Switch, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Btn, Card, Chip, Empty, ErrorBox, Field, GradCard, H1, Loading, Row, Screen, Seg, Section, StatPill, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { SportSelect, useSports } from '../sportpicker';
import { c, when } from '../theme';
import { locale } from '../locale';
import { moneyIn } from '../vtime';

import { KINDS, MODES, Explore, Reviews, BucketButton, RatingTag } from './study';
import { Plan, SharedPathways } from './pathway-plan';
import { AdaptiveLearn } from './para-learn';
export { KINDS, MODES };
export const STAGES = [['new', 'New'], ['in_conversation', 'In conversation'], ['referred', 'Sent to apply'], ['applied', 'Applied'], ['admitted', 'Admitted'], ['enrolled', 'Enrolled'], ['declined', 'Declined'], ['withdrawn', 'Withdrawn'], ['closed', 'Closed']];
export const label = (list, v) => list.find(([k]) => k === v)?.[1] ?? String(v).replace(/_/g, ' ');
export const openLink = (url) => (Platform.OS === 'web' ? window.open(url, '_blank', 'noopener') : Linking.openURL(url));
const day = (d) => new Date(d).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });
const fail = (toast) => (e) => toast('' + e.message);
const opts = (list) => list.map(([value, l]) => ({ value, label: l }));

/** Certificates and badges as they appear on a profile or passport. */
export function CredentialList({ list }) {
  return (
    <View style={{ gap: 10 }}>
      {list.map((x) => (
        <Card key={x.id} pad={14}>
          <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
            <T size={30}>{x.kind === 'badge' ? '🎖️' : x.kind === 'degree' || x.kind === 'diploma' ? '🎓' : '📜'}</T>
            <View style={{ flex: 1 }}>
              <T weight="700">{x.title}</T>
              <T size={12} color={c.mute}>{x.institution}{x.sport ? ` · ${x.sport_emoji ?? ''} ${x.sport}` : ''} · {day(x.issued_on)}{x.expires_on ? ` – ${day(x.expires_on)}` : ''}</T>
              <T size={11} color={c.mute}>Verify with code {x.code}</T>
            </View>
          </View>
        </Card>
      ))}
    </View>
  );
}

// ------------------------------------------------------------------ the hub
export function Pathways() {
  const { push } = useNav();
  const { user } = useSession();
  const [tab, setTab] = useState('explore');
  const saved = useLoad(() => api.get('/pathway-plans/count'), []);
  const unread = useLoad(() => api.get('/learn/enquiries/unread-count'), []);

  return (
    <Screen>
      <GradCard colors={[c.violet, c.ink]}>
        <H1 color="#fff" style={{ fontSize: 28 }}>Learn & study sport</H1>
        <T color="#fff" weight="600" style={{ marginTop: 4 }}>Turn your sport into a qualification: find colleges near you, compare courses, save your favourites and apply.</T>
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 14 }}>
          <StatPill value={saved} label="Targets" /><StatPill value={(enq.data ?? []).length} label="Enquiries" /><StatPill value={unread} label="Unread replies" />
        </View>
      </GradCard>
      <View style={{ marginTop: 12 }}>
        <Seg value={tab} onChange={setTab} color={c.violet} options={[{ value: 'explore', label: 'Explore' }, { value: 'plan', label: saved ? `My plan (${saved})` : 'My plan' }, { value: 'adaptive', label: 'Adaptive sport' }, { value: 'rules', label: 'Rules' }, { value: 'enquiries', label: unread ? `Enquiries (${unread})` : 'Enquiries' }, { value: 'credentials', label: 'Badges' }, ...(user.roles.includes('coach') ? [{ value: 'shared', label: 'Shared with me' }] : [])]} />
      </View>
      {tab === 'explore' ? <Explore push={push} onSaved={bucket.reload} /> : null}
      {tab === 'plan' ? <Plan onExplore={() => setTab('explore')} /> : null}
      {tab === 'shared' ? <SharedPathways push={push} /> : null}
      {tab === 'adaptive' ? <AdaptiveLearn push={push} /> : null}
      {tab === 'rules' ? <Learn onFind={() => setTab('explore')} /> : null}
      {tab === 'enquiries' ? <Enquiries list={enq} push={push} /> : null}
      {tab === 'credentials' ? <MyCredentials /> : null}
    </Screen>
  );
}

export function Programme({ id }) { return <ProgrammeDetail id={id} />; }
export function Institution({ id }) { return <InstitutionPage id={id} />; }
export function Enquiry({ id }) { return <EnquiryThread id={id} />; }

// ------------------------------------------------------------------ learn (rules)
function Learn({ onFind }) {
  const [sportId, setSportId] = useState(null);
  const rules = useLoad(() => api.get('/sport-rules', sportId ? { sport_id: sportId } : {}), [sportId]);
  return (
    <>
      <SportSelect value={sportId} onChange={setSportId} label="Sport" />
      {rules.error ? <ErrorBox error={rules.error} onRetry={rules.reload} /> : !rules.data ? <Loading /> : rules.data.length === 0 ? (
        <Empty emoji="📚" title="No rules content yet for this sport." sub="Browse programmes instead." action="Browse" onAction={onFind} />
      ) : rules.data.map((r) => <RuleCard key={r.id} rule={r} />)}
    </>
  );
}

function RuleCard({ rule }) {
  return (
    <Card pad={14} style={{ marginTop: 8 }}>
      <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
        <T size={24}>{rule.sport_emoji}</T>
        <View style={{ flex: 1 }}>
          <T weight="700">{rule.sport_name}</T>
          <T size={12} color={c.mute}>{rule.edition} · {rule.governing_body}</T>
        </View>
        {rule.url ? <Btn small title="Open" color={c.paper} ink={c.pink} onPress={() => openLink(rule.url)} /> : null}
      </View>
    </Card>
  );
}

// ------------------------------------------------------------------ explore → programme → institution
function ProgrammeDetail({ id }) {
  const { push } = useNav();
  const prog = useLoad(() => api.get(`/learn/programmes/${id}`), [id]);
  if (prog.error) return <Screen><ErrorBox error={prog.error} onRetry={prog.reload} /></Screen>;
  if (!prog.data) return <Screen><Loading /></Screen>;
  const p = prog.data;
  return (
    <Screen title={p.name}>
      <GradCard colors={[c.violet, c.ink]}>
        <T size={28} weight="800" color="#fff">{p.name}</T>
        <T size={14} color="#fff" style={{ marginTop: 4 }}>{p.institution_name}</T>
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          {p.kind && <StatPill value={label(KINDS, p.kind)} />}
          {p.mode && <StatPill value={label(MODES, p.mode)} />}
          {p.duration_months ? <StatPill value={`${p.duration_months}m`} label="Duration" /> : null}
          {p.fee_per_month_usd ? <StatPill value={`$${p.fee_per_month_usd}/mo`} label="Fee" /> : null}
        </View>
      </GradCard>
      {p.overview ? <Section title="Overview"><T>{p.overview}</T></Section> : null}
      {p.highlights?.length ? <Section title="Highlights">{p.highlights.map((h, i) => <T key={i}>• {h}</T>)}</Section> : null}
      {p.sports?.length ? <Section title="Sports">{p.sports.map((s) => <Chip key={s.id} label={`${s.emoji} ${s.name}`} />)}</Section> : null}
      {p.curriculum?.length ? (
        <Section title="Curriculum">
          {p.curriculum.map((m, i) => (
            <Card key={i} pad={12}><T weight="700">{m.title}</T>{m.description ? <T size={13} color={c.mute}>{m.description}</T> : null}</Card>
          ))}
        </Section>
      ) : null}
      {p.reviews_summary ? <Reviews summary={p.reviews_summary} /> : null}
      <Section>
        {p.institution_id && <Btn title="View institution" color={c.paper} ink={c.pink} onPress={() => push('Institution', { id: p.institution_id })} style={{ marginBottom: 8 }} />}
        <BucketButton programmeId={p.id} style={{ marginBottom: 8 }} />
        <Btn title="Enquire" onPress={() => push('Enquiry', { programme_id: p.id })} />
      </Section>
    </Screen>
  );
}

function InstitutionPage({ id }) {
  const { push } = useNav();
  const inst = useLoad(() => api.get(`/learn/institutions/${id}`), [id]);
  if (inst.error) return <Screen><ErrorBox error={inst.error} onRetry={inst.reload} /></Screen>;
  if (!inst.data) return <Screen><Loading /></Screen>;
  const i = inst.data;
  return (
    <Screen title={i.name}>
      <GradCard colors={[c.violet, c.ink]}>
        <T size={26} weight="800" color="#fff">{i.name}</T>
        <T size={13} color="#fff" style={{ marginTop: 4 }}>{i.country}{i.city ? `, ${i.city}` : ''}</T>
        {i.overview ? <T size={13} color="rgba(255,255,255,0.8)" style={{ marginTop: 6 }}>{i.overview}</T> : null}
      </GradCard>
      {i.programmes?.length ? (
        <Section title="Programmes">
          {i.programmes.map((p) => (
            <Card key={p.id} pad={14} style={{ marginTop: 6 }}>
              <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
                <View style={{ flex: 1 }}><T weight="700">{p.name}</T><T size={12} color={c.mute}>{label(KINDS, p.kind)} · {label(MODES, p.mode)}</T></View>
                <Btn small title="View" color={c.paper} ink={c.pink} onPress={() => push('Programme', { id: p.id })} />
              </View>
            </Card>
          ))}
        </Section>
      ) : null}
      {i.reviews_summary ? <Reviews summary={i.reviews_summary} /> : null}
      <Section><Btn title="Enquire about this institution" onPress={() => push('Enquiry', { institution_id: i.id })} /></Section>
    </Screen>
  );
}

// ------------------------------------------------------------------ enquiries
function Enquiries({ push }) {
  const enqs = useLoad(() => api.get('/learn/enquiries'), []);
  if (enqs.error) return <ErrorBox error={enqs.error} onRetry={enqs.reload} />;
  if (!enqs.data) return <Loading />;
  if (!enqs.data.length) return <Empty emoji="📬" title="No enquiries yet" sub="Explore programmes and start a conversation." />;
  return (
    <Section>
      {enqs.data.map((e) => (
        <Card key={e.id} pad={14} style={{ marginTop: 6 }}>
          <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
            <View style={{ flex: 1 }}>
              <T weight="700">{e.programme_name ?? e.institution_name}</T>
              <T size={12} color={c.mute}>{label(STAGES, e.stage)} · {day(e.updated_at)}</T>
            </View>
            {e.unread ? <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: c.pink }} /> : null}
            <Btn small title="Open" color={c.paper} ink={c.pink} onPress={() => push('Enquiry', { id: e.id })} />
          </View>
        </Card>
      ))}
    </Section>
  );
}

function EnquiryThread({ id, programme_id, institution_id }) {
  const { toast } = useSession();
  const [msg, setMsg] = useState('');
  const thread = useLoad(() => {
    if (id) return api.get(`/learn/enquiries/${id}`);
    return api.post('/learn/enquiries', { programme_id, institution_id }).then((r) => r);
  }, [id, programme_id, institution_id]);
  if (thread.error) return <Screen><ErrorBox error={thread.error} /></Screen>;
  if (!thread.data) return <Screen><Loading /></Screen>;
  const { enquiry, messages, stage } = thread.data;
  const send = async () => {
    if (!msg.trim()) return;
    try { await api.post(`/learn/enquiries/${enquiry.id}/messages`, { text: msg }); setMsg(''); thread.reload(); }
    catch (e) { fail(toast)(e); }
  };
  return (
    <Screen title={enquiry.programme_name ?? enquiry.institution_name}>
      <Card pad={12} style={{ marginBottom: 8 }}><T size={12} color={c.mute}>Status</T><T weight="700">{label(STAGES, stage)}</T></Card>
      {messages.map((m) => (
        <Card key={m.id} pad={12} style={{ marginTop: 4, alignSelf: m.sender === 'athlete' ? 'flex-end' : 'flex-start', maxWidth: '85%', backgroundColor: m.sender === 'athlete' ? c.pink : c.paper }}>
          <T color={m.sender === 'athlete' ? '#fff' : c.ink}>{m.text}</T>
          <T size={10} color={m.sender === 'athlete' ? 'rgba(255,255,255,0.7)' : c.mute} style={{ marginTop: 2 }}>{day(m.created_at)}</T>
        </Card>
      ))}
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 12, alignItems: 'center' }}>
        <Field value={msg} onChangeText={setMsg} placeholder="Message…" style={{ flex: 1 }} />
        <Btn title="Send" onPress={send} style={{ minWidth: 60 }} />
      </View>
    </Screen>
  );
}

// ------------------------------------------------------------------ credentials
function Credentials({ push }) {
  const creds = useLoad(() => api.get('/athletes/me/credentials'), []);
  const { user } = useSession();
  const isAdmin = user?.roles?.includes('admin') || user?.roles?.includes('platform_admin');
  if (creds.error) return <ErrorBox error={creds.error} onRetry={creds.reload} />;
  if (!creds.data) return <Loading />;
  if (!creds.data.length && !isAdmin) return <Empty emoji="🎖️" title="No badges or certificates yet" sub="Complete programmes and adaptive learning paths to earn them." />;
  return (
    <>
      <CredentialList list={creds.data} />
      {isAdmin && <IssueCredential onDone={creds.reload} />}
    </>
  );
}

function IssueCredential({ onDone }) {
  const sports = useSports();
  const idOf = (sportSlug) => sports.data?.find((s) => s.slug === sportSlug)?.id ?? sportSlug;
  return (
    <>
      <T weight="700" style={{ marginTop: 20, marginBottom: 8 }}>Issue credential (admin)</T>
      <FormSheet visible title="Issue credential" submitLabel="Issue"
        fields={[
          { key: 'recipient_id', label: 'Athlete ID' },
          { key: 'kind', label: 'Kind', type: 'chips', options: [{ value: 'badge', label: 'Badge' }, { value: 'certificate', label: 'Certificate' }, { value: 'diploma', label: 'Diploma' }, { value: 'degree', label: 'Degree' }] },
          { key: 'title', label: 'Title' },
          { key: 'description', label: 'Description', type: 'multiline', optional: true },
          { key: 'sport', label: 'Sport', type: 'sport', optional: true },
          { key: 'expires_on', label: 'Expiry', type: 'date', optional: true },
        ]}
        onSubmit={async (v) => { const r = await api.post('/athletes/credentials/issue', { recipient_id: v.recipient_id, kind: v.kind, title: v.title, description: v.description, sport_id: v.sport ? idOf(v.sport) : undefined, expires_on: v.expires_on }); onDone(); return `Issued (${r.code})`; }} />
    </>
  );
}
