// The household view at the top of the existing Family screen (issue #572): one account, every dependent, one to-do list and one calendar.
// Pure presentation over GET /me/family and /me/family/schedule; every action calls the capability that already owns it
// (team RSVP, competition registration, hosted payment, trip consent, youth consent), which re-checks the guardian link on the server.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { useLayout } from '../layout';
import { PaySheet } from '../PaySheet';
import { FormSheet } from '../FormSheet';
import { t as tr } from '../i18n';
import { Avatar, Btn, Card, Chip, Empty, ErrorBox, HScroll, Loading, Section, StatPill, T, Tag } from '../ui';
import { c } from '../theme';
import { locale } from '../locale';
import { dateTimeIn, moneyIn } from '../vtime';

const day = (d) => (d ? new Date(d).toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short' }) : '');
const KIND = { rsvp: ['Answer', c.cyanSoft], payment: ['Pay', c.sunSoft], registration: ['Register', c.mintSoft], trip_consent: ['Trip consent', c.orangeSoft], consent: ['Permission', c.violetSoft], renew_link: ['Verification', c.pinkSoft] };
const SCOPES = ['pay', 'register', 'rsvp', 'travel_consent', 'consent', 'calendar'];
const scopeOptions = () => SCOPES.map((s) => ({ value: s, label: tr(`family.scope.${s}`) }));
const REG = { submitted: 'Submitted', under_review: 'Under review', registered: 'Registered', suspended: 'Suspended' };

function Who({ p, size = 28 }) {
  return <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><Avatar user={p} size={size} /><T weight="800" size={13}>{p.display_name}</T></View>;
}

/** Narrow what one guardian may do (own link: reduce only; another guardian's: the primary guardian). Re-checked on the server. */
function ScopesSheet({ target, onClose, onDone }) {
  return (
    <FormSheet visible={!!target} onClose={onClose} title={target ? `${tr('family.scopes.open')} · ${target.name}` : tr('family.scopes.open')} initial={{ scopes: target?.scopes ?? SCOPES }}
      fields={[{ key: 'scopes', label: tr('family.scopes.title'), type: 'multimenu', options: scopeOptions(), hint: tr('family.scopes.note') }]}
      onSubmit={async (v) => { await api.patch(`/youth/guardian-links/${target.link_id}/scopes`, { scopes: v.scopes ?? [] }); onDone(); return tr('family.scopes.saved'); }} />
  );
}

function Todo({ t: item, reload, onConsents, onPay }) {
  const { toast } = useSession();
  const { push } = useNav();
  const [busy, setBusy] = useState(false);
  const t = item;
  const a = t.action;
  const run = async (fn, msg) => { setBusy(true); try { await fn(); toast(msg); reload(); } catch (e) { toast(e.message); } finally { setBusy(false); } };
  const rsvp = (v) => run(() => api.post(`/teams/${a.team_id}/attendance`, { for_user_id: a.child_id, rsvp: v, ...(a.fixture_id ? { fixture_id: a.fixture_id } : { event_id: a.event_id }) }), 'Answer sent');
  return (
    <Card pad={14} accessibilityLabel={t.title}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <Who p={t.person} />
        <View style={{ flexDirection: 'row', gap: 6 }}>
          {t.overdue ? <Tag label="Overdue" color={c.red} /> : null}
          <Tag label={KIND[t.kind][0]} color={KIND[t.kind][1]} />
        </View>
      </View>
      <T weight="700" style={{ marginTop: 8 }}>{t.title}</T>
      {t.due_at ? <T size={12} color={c.mute}>{t.kind === 'payment' ? 'Due' : 'On'} {day(t.due_at)}</T> : null}
      {t.blocked ? <T size={12} color={c.orange} style={{ marginTop: 8 }} accessibilityRole="alert">{tr('family.blocked')}</T> : null}
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
        {t.kind === 'rsvp' ? <>
          <Btn small title="Going" color={c.pink} disabled={busy || !!t.blocked} onPress={() => rsvp('going')} />
          <Btn small title="Maybe" color={c.paper} ink={c.ink} disabled={busy || !!t.blocked} onPress={() => rsvp('maybe')} />
          <Btn small title="Can't go" color={c.paper} ink={c.red} disabled={busy || !!t.blocked} onPress={() => rsvp('no')} />
        </> : null}
        {t.kind === 'payment' ? (a.purpose
          ? <Btn small title={`Pay ${moneyIn(t.amount.minor, t.amount.currency)}`} color={c.pink} disabled={!!t.blocked} onPress={() => onPay({ type: a.purpose.purpose_type, id: a.purpose.purpose_id, label: t.title, amount: t.amount.minor, currency: t.amount.currency })} />
          : <T size={12} color={c.mute}>Part of a sale waiting at the front desk: pay it there.</T>) : null}
        {t.kind === 'registration' ? <Btn small title="Register" color={c.pink} disabled={busy || !!t.blocked} onPress={() => run(() => api.post(`/events/${a.event_id}/registrations`, { team_id: a.team_id, user_id: a.child_id }), 'Registration sent')} /> : null}
        {t.kind === 'trip_consent' ? <Btn small title="Review trip" color={c.pink} disabled={!!t.blocked} onPress={() => push('Trip', { id: a.trip_id })} /> : null}
        {t.kind === 'consent' ? <Btn small title="Review permissions" color={c.pink} disabled={!!t.blocked} onPress={() => onConsents(t.person)} /> : null}
      </View>
    </Card>
  );
}

function Calendar({ who }) {
  const q = useLoad(() => api.get('/me/family/schedule', who ? { child_id: who } : {}), [who]);
  if (q.loading && !q.data) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={q.reload} />;
  const d = q.data;
  return (
    <View style={{ gap: 8 }}>
      {d.family_clashes.length ? (
        <Card color={c.sunSoft} pad={12} accessibilityLabel="Clash warning">
          <T weight="800" size={13}>Two places at once</T>
          {d.family_clashes.slice(0, 3).map((x, i) => <T key={i} size={12} color={c.mute}>{x.map((y) => `${y.person_name}: ${y.title}`).join('  ·  ')} · {day(x[0].starts_at)}</T>)}
        </Card>
      ) : null}
      {d.items.length ? d.items.slice(0, 20).map((x) => (
        <Card key={`${x.person.id}-${x.source_type}-${x.source_id}`} pad={12} color={x.family_clash ? c.sunSoft : c.paper} accessibilityLabel={`${x.person.display_name}, ${x.title}`}>
          <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
            <Avatar user={x.person} size={32} />
            <View style={{ flex: 1 }}>
              <T weight="700" size={14}>{x.title}</T>
              <T size={12} color={c.mute}>{x.person.is_me ? 'You' : x.person.display_name} · {x.all_day ? day(x.starts_at) : dateTimeIn(x.starts_at, x.timezone)}{x.context ? ` · ${x.context}` : ''}</T>
            </View>
            {x.rsvp ? <Tag label={x.rsvp.value === 'pending' ? 'Not answered' : x.rsvp.value} color={x.rsvp.value === 'going' ? c.mint : c.violetSoft} /> : null}
          </View>
        </Card>
      )) : <Empty emoji="📅" title="Nothing scheduled" sub="Matches, training and events for your family appear here." />}
    </View>
  );
}

function Child({ d, onConsents, onScopes }) {
  const { push } = useNav();
  const lapsed = d.consents.filter((k) => ['expired', 'lapsed'].includes(k.state)).length;
  return (
    <Card pad={14}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Who p={d.person} size={36} />
        <View style={{ flexDirection: 'row', gap: 6 }}>
          <Tag label={String(d.relationship).replace(/_/g, ' ')} />
          {d.needs_attention ? <Tag label={`${d.needs_attention} to sort`} color={c.orange} /> : <Tag label="All good" color={c.mint} />}
        </View>
      </View>
      {d.teams.length ? <>
        <T size={12} weight="800" color={c.mute} style={{ marginTop: 10 }}>TEAMS & MESSAGES</T>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
          {d.teams.map((t) => <Btn key={t.id} small title={`${t.emoji ?? '💬'} ${t.name}`} color={c.paper} ink={c.ink} onPress={() => push('TeamChat', { id: t.id })} />)}
        </View>
      </> : <T size={12} color={c.mute} style={{ marginTop: 8 }}>Not on a team yet.</T>}
      {d.registrations.length ? <>
        <T size={12} weight="800" color={c.mute} style={{ marginTop: 10 }}>REGISTRATIONS</T>
        {d.registrations.map((r) => <T key={r.id} size={13}>{r.event_name} · {r.team_name} · <T size={13} weight="700">{REG[r.status] ?? r.status}</T></T>)}
      </> : null}
      {d.trips.length ? <>
        <T size={12} weight="800" color={c.mute} style={{ marginTop: 10 }}>TRAVEL</T>
        {d.trips.map((t) => (
          <T key={t.participant_id} size={13} onPress={() => push('Trip', { id: t.trip_id })} accessibilityRole="link">{t.name} · {t.origin} → {t.destination} · {day(t.depart_at)}{t.legs ? ` · ${t.legs} leg${t.legs > 1 ? 's' : ''}` : ''}{t.consent_current ? '' : ' · consent needed'}</T>
        ))}
      </> : null}
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
        <Btn small title={lapsed ? `Permissions (${lapsed} to renew)` : 'Permissions'} color={c.violet} onPress={() => onConsents(d.person)} />
        <Btn small title={tr('family.scopes.open')} color={c.paper} ink={c.ink} onPress={() => onScopes({ link_id: d.link_id, name: d.person.display_name, scopes: d.scopes })} />
        {d.link_expires_at ? <T size={12} color={c.mute} style={{ alignSelf: 'center' }}>Verified until {day(d.link_expires_at)}{d.guardians > 1 ? ` · ${d.guardians} guardians` : ''}</T> : null}
      </View>
      {d.co_guardians?.length ? <>
        <T size={12} weight="800" color={c.mute} style={{ marginTop: 10 }}>{tr('family.scopes.title').toUpperCase()}</T>
        {d.co_guardians.map((g) => (
          <View key={g.link_id} style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 4 }}>
            <T size={13} style={{ flex: 1 }}>{g.display_name} · {g.scopes.length} / {SCOPES.length}</T>
            <Btn small title={tr('family.scopes.open')} color={c.paper} ink={c.ink} onPress={() => onScopes({ link_id: g.link_id, name: g.display_name, scopes: g.scopes })} />
          </View>
        ))}
      </> : null}
    </Card>
  );
}

/** Rendered by the Family screen for anyone who is a verified guardian. Renders nothing for people with no dependents. */
export function FamilyDashboard({ onConsents }) {
  const { push } = useNav();
  const L = useLayout();
  const [who, setWho] = useState(null);
  const [pay, setPay] = useState(null);
  const [scopes, setScopes] = useState(null);
  const q = useLoad(() => api.get('/me/family', who ? { child_id: who } : {}), [who]);
  const kids = useLoad(() => api.get('/me/family'), []);
  if (kids.data && !kids.data.dependents.length) return null;
  if ((q.loading && !q.data) || (kids.loading && !kids.data)) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={q.reload} />;
  const d = q.data;
  const reload = () => { q.reload(); kids.reload(); };
  const due = d.due.map((x) => moneyIn(x.due_minor, x.currency)).join(' · ');
  const todo = (
    <Section title="To do" color={c.pink}>
      {d.todo.length ? d.todo.map((t, i) => <Todo key={`${t.kind}-${i}-${t.action.child_id}-${t.title}`} t={t} reload={reload} onConsents={onConsents} onPay={setPay} />)
        : <Empty emoji="✅" title="You're all caught up" sub="Forms, payments, RSVPs and registrations that need you will show here." />}
    </Section>
  );
  const cal = <Section title="Family calendar" color={c.cyan}><Calendar who={who} /></Section>;
  return (
    <View style={{ gap: 6 }}>
      <T size={12} weight="800" color={c.mute}>WHOSE FAMILY VIEW?</T>
      <HScroll>
        <Chip label="Everyone" active={!who} onPress={() => setWho(null)} />
        {(kids.data?.dependents ?? []).map((k) => <Chip key={k.person.id} label={k.person.display_name} active={who === k.person.id} onPress={() => setWho(k.person.id)} />)}
      </HScroll>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginVertical: 8 }}>
        <StatPill value={String(d.todo.length)} label="To do" />
        <StatPill value={due || '—'} label={d.overdue ? `Due · ${d.overdue} overdue` : 'Due'} />
        <StatPill value={String(d.unread_notifications)} label="Unread" />
      </View>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <Btn small title={`🔔 Notifications${d.unread_notifications ? ` (${d.unread_notifications})` : ''}`} color={c.paper} ink={c.ink} onPress={() => push('Inbox')} />
      </View>
      {L.tablet ? (
        <View style={{ flexDirection: 'row', gap: 16, alignItems: 'flex-start' }}>
          <View style={{ flex: 1, gap: 6 }}>{todo}</View>
          <View style={{ flex: 1, gap: 6 }}>{cal}</View>
        </View>
      ) : <>{todo}{cal}</>}
      <Section title={who ? 'This family member' : 'Each family member'} color={c.violet}>
        {d.dependents.map((x) => <Child key={x.person.id} d={x} onConsents={onConsents} onScopes={setScopes} />)}
      </Section>
      <ScopesSheet target={scopes} onClose={() => setScopes(null)} onDone={reload} />
      {pay ? <PaySheet target={pay} onClose={() => setPay(null)} onDone={reload} /> : null}
    </View>
  );
}
