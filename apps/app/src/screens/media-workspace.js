// Media rights (#482): the workspace of a media partner (broadcaster, streaming platform, press, photo agency, production company, data licensee) and of production crew.
// It shows exactly what a licence grants: the rights held, the games and events they cover, the media the partner may use with its embargo and release conditions, the production
// schedule and accreditation actions, the data feeds, and notices. A media agreement never opens a team, player or organisation record, so none appears here.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { A, ABtn, ACard, AChip, AEmpty, AHero, ARow, AScreen, ASection, AStat, AT, AG } from '../arena';
import { ErrorBox, Loading } from '../ui';
import { FormSheet } from '../FormSheet';
import { PARTNER_KINDS, rightLabel, fmtDT, fmtRange, money, nice, StateTag, Tags, crewRole } from '../media-ui';
import { OfferForm, LicenceSheet } from './media-licence';
import { ProductionPanel, StreamsPanel } from './media-production';
import { AssetsPanel } from './media-assets';

const TABS = [['rights', '🧾 Rights'], ['schedule', '🗓️ Games'], ['production', '🎬 Production'], ['streams', '📺 Streams'], ['media', '🎞️ Media'], ['find', '🔎 Find rights']];

export function MediaWorkspace() {
  const { toast } = useSession();
  const [pid, setPid] = useState(null);
  const ws = useLoad(() => api.get('/media-workspace', pid ? { partner_id: pid } : {}), [pid]);
  const mine = useLoad(() => api.get('/me/media-assignments'), []);
  const orgs = useLoad(() => api.get('/organisations').catch(() => []), []);
  const [tab, setTab] = useState('rights');
  const [evId, setEvId] = useState(null);
  const [open, setOpen] = useState(null);
  const [reg, setReg] = useState(false);
  if (ws.error) return <AScreen><ErrorBox error={ws.error} onRetry={ws.reload} /></AScreen>;
  if (!ws.data || !mine.data) return <AScreen><Loading /></AScreen>;
  const w = ws.data;
  const partner = w.partner;
  const reload = () => { ws.reload(); mine.reload(); };
  const assignments = mine.data.length ? (
<>
          <ASection title="My assignments" sub="Production roles you have been given" />
          {mine.data.map((c) => (
            <ARow key={c.id} left={<AT size={22}>🎥</AT>} title={`${crewRole(c.role)} · ${c.event_name}`} sub={[c.home_name ? `${c.home_name} v ${c.away_name}` : 'Whole event', c.call_time ? `Call ${fmtDT(c.call_time)}` : null, c.camera_position, c.booth_ref].filter(Boolean).join(' · ')}
              right={<><StateTag state={c.status} /><StateTag state={c.accreditation === 'issued' ? 'issued' : c.accreditation === 'revoked' ? 'revoked' : 'none'} label={c.accreditation === 'issued' ? 'Badge issued' : c.accreditation === 'revoked' ? 'Badge revoked' : c.accreditation === 'requested' ? 'Badge requested' : 'No badge yet'} />
                {c.status === 'assigned' ? <ABtn small title="Confirm" tone="lime" onPress={async () => { try { await api.post(`/media/crew/${c.id}/respond`, { accept: true }); toast('Confirmed'); reload(); } catch (x) { toast(x.message); } }} /> : null}</>} />
          ))}
        </>
      ) : null;
  const heroSub = partner ? `${nice(partner.kind)} · you are ${nice(partner.role)}` : 'Rights, production and data feeds for media partners';

  return (
    <AScreen>
      <AHero kicker="MEDIA & BROADCAST" title={partner?.name ?? 'Media workspace'} sub={heroSub} tone={AG.neon} emoji="📡" />
      {w.partners.length > 1 ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{w.partners.map((p) => <AChip key={p.partner_id} label={p.name} active={p.partner_id === partner?.partner_id} onPress={() => { setPid(p.partner_id); setEvId(null); }} />)}</View> : null}

      {!partner ? assignments : null}
      {!partner ? (
        <AEmpty emoji="📡" title="Not a media partner yet" sub="Register your organisation to be offered, or to apply for, broadcast, streaming, press, photography and data rights. Your organisation keeps its identity and members; this only marks it as able to hold rights." action="Register an organisation" onAction={() => setReg(true)} />
      ) : (
        <>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
            <AStat icon="✅" value={w.summary.held_now} label="Rights held" /><AStat icon="⏳" value={w.summary.awaiting_answer} label="Awaiting answer" /><AStat icon="📅" value={w.summary.expiring_30d} label="Ending ≤30d" /><AStat icon="🎥" value={w.crew.length} label="Crew" />
          </View>
          {w.notices.length ? (
            <ACard tone={A.sun} pad={12} style={{ gap: 6 }}>
              <AT size={13} weight="900">NEEDS YOUR ATTENTION</AT>
              {w.notices.slice(0, 6).map((n, i) => <AT key={i} size={13.5} weight="700" onPress={n.licence_id ? () => setOpen(n.licence_id) : undefined}>• {n.text}</AT>)}
            </ACard>
          ) : null}

          {assignments}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{TABS.map(([k, l]) => <AChip key={k} label={l} active={tab === k} onPress={() => setTab(k)} />)}</View>

          {tab === 'rights' ? (
            <>
              <ASection title="My licences" />
              {!w.licences.length ? <AEmpty emoji="🧾" title="No licences yet" sub="Find rights that organisers have opened, or wait for an offer." action="Find rights" onAction={() => setTab('find')} /> : w.licences.map((l) => (
                <ARow key={l.id} onPress={() => setOpen(l.id)} left={<AT size={22}>{l.in_force ? '📡' : '🤝'}</AT>} title={`${l.event_name} · ${l.package_name}`} sub={`${l.approved_rights.map(rightLabel).join(', ')} · ${fmtRange(l.effective_from, l.effective_to)}${Number(l.fee_minor) ? ` · ${money(l.fee_minor, l.currency)}` : ''}`}
                  right={<><StateTag state={l.stage_now} />{l.in_force && l.days_left <= 30 ? <StateTag state="attention" label={`${l.days_left}d left`} /> : null}</>} />
              ))}
              {w.conditions.length ? (
                <>
                  <ASection title="Release conditions" sub="What the organiser's terms mean for what you publish" />
                  {w.conditions.map((c) => <ACard key={c.licence_id} pad={12}><AT size={13} color={A.mute}>{w.events.find((e) => e.id === c.event_id)?.name}: <AT size={13} weight="700">{c.text}</AT></AT></ACard>)}
                </>
              ) : null}
              {w.feeds.length ? (
                <>
                  <ASection title="Data feeds" sub="Official scores and results for your systems" />
                  {w.feeds.map((f) => <ARow key={f.id} onPress={() => setOpen(f.licence_id)} left={<AT size={22}>📡</AT>} title={f.consumer_name} sub={`${f.datasets.map(nice).join(' · ')} · ${f.mode === 'live' ? 'real-time' : 'delayed'} · ${f.calls_today} calls today`} right={<StateTag state={f.usable ? 'usable' : 'expired'} label={f.usable ? 'Active' : 'Ended'} />} />)}
                </>
              ) : null}
            </>
          ) : null}

          {tab === 'schedule' ? (
            <>
              {!w.fixtures.length ? <AEmpty emoji="🗓️" title="No games in your licensed scope" sub="Games appear here once a licence is in force." /> : w.events.map((ev) => (
                <View key={ev.id} style={{ gap: 8 }}>
                  <ASection title={ev.name} sub={`${ev.sport}${ev.venue ? ` · ${ev.venue}` : ''}`} />
                  {w.fixtures.filter((f) => f.event_id === ev.id).map((f) => <ARow key={f.id} title={`${f.home_emoji ?? ''} ${f.home_name ?? 'TBC'}  v  ${f.away_name ?? 'TBC'} ${f.away_emoji ?? ''}`.trim()} sub={`${fmtDT(f.scheduled_at)}${f.round ? ` · ${f.round}` : ''}`} right={<StateTag state={f.status === 'completed' ? 'ended' : f.status === 'live' ? 'live' : 'scheduled'} label={nice(f.status)} />} />)}
                </View>
              ))}
            </>
          ) : null}

          {['production', 'streams', 'media'].includes(tab) ? (
            <EventScoped w={w} evId={evId} setEvId={setEvId}>
              {(ev, licences, games) => (tab === 'production' ? <ProductionPanel id={ev.id} isOrg={false} canAct={partner.can_act} games={games} licences={licences} />
                : tab === 'streams' ? <StreamsPanel id={ev.id} isOrg={false} canAct={partner.can_act} games={games} licences={licences} />
                : <AssetsPanel id={ev.id} isOrg={false} games={games} partners={w.partners} />)}
            </EventScoped>
          ) : null}

          {tab === 'find' ? <Opportunities partner={partner} onChanged={reload} /> : null}
        </>
      )}

      <FormSheet visible={reg} onClose={() => setReg(false)} title="Register as a media partner" notice="Choose an organisation you own or administer. Create one first under Organisations if you have none."
        fields={[{ key: 'organisation_id', label: 'Organisation', type: 'chips', options: (orgs.data ?? []).filter((o) => o.my_status === 'active' && ['owner', 'admin'].includes(o.my_role) && o.status === 'active' && !w.partners.some((p) => p.organisation_id === o.id)).map((o) => ({ value: o.id, label: o.name })) }, { key: 'kind', label: 'What kind of media partner', type: 'chips', options: PARTNER_KINDS.map((k) => ({ value: k, label: nice(k) })), default: 'broadcaster' }]}
        submitLabel="Register" onSubmit={async (v) => { await api.post('/media/partners', v); reload(); return 'Registered. You can now be offered rights.'; }} />
      {open ? <LicenceSheet id={open} onClose={() => setOpen(null)} onChanged={reload} /> : null}
    </AScreen>
  );
}

/** The panels work on one event at a time: pick which of the events you hold rights to. */
function EventScoped({ w, evId, setEvId, children }) {
  const live = w.licences.filter((l) => l.in_force);
  const events = w.events;
  const ev = events.find((e) => e.id === evId) ?? events[0];
  if (!ev) return <AEmpty emoji="🎬" title="No event yet" sub="Once a licence is in force, the event appears here." />;
  const licences = live.filter((l) => l.event_id === ev.id).map((l) => ({ id: l.id, licence_id: l.id, package_name: l.package_name }));
  return (
    <>
      {events.length > 1 ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{events.map((e) => <AChip key={e.id} label={e.name} active={e.id === ev.id} onPress={() => setEvId(e.id)} />)}</View> : null}
      <AT size={12.5} color={A.mute}>{ev.name}{ev.venue ? ` · ${ev.venue}` : ''}</AT>
      {children(ev, licences, w.fixtures.filter((f) => f.event_id === ev.id))}
    </>
  );
}

function Opportunities({ partner, onChanged }) {
  const d = useLoad(() => api.get('/media/opportunities', { limit: 50 }), []);
  const [apply, setApply] = useState(null);
  if (d.error) return <ErrorBox error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  return (
    <>
      <ASection title="Rights open to apply for" sub="Packages organisers have opened to media partners" />
      {!d.data.length ? <AEmpty emoji="🔎" title="Nothing is open right now" sub="Organisers open packages when they are ready for proposals. Check back, or ask an organiser to offer you rights directly." /> : d.data.map((p) => (
        <ACard key={p.id} pad={14} style={{ gap: 6 }}>
          <AT size={16} weight="900">{p.event_name}</AT>
          <AT size={12.5} color={A.mute}>{p.name} · {p.sport} · {fmtRange(p.valid_from, p.valid_to)}</AT>
          <Tags items={p.rights.map(rightLabel)} />
          <AT size={12.5} color={A.mute}>{p.exclusivity === 'exclusive' ? 'Exclusive' : 'Non-exclusive'} · {p.territory_mode === 'worldwide' ? 'Worldwide' : `${p.territory_mode === 'exclude' ? 'Except ' : ''}${p.countries.join(', ')}`}{p.embargo_minutes ? ` · ${p.embargo_minutes} min delay after games` : ''}</AT>
          {p.already_involved ? <StateTag state="proposed" label="You already have an offer" /> : partner.can_act ? <ABtn small title="Apply" tone="neon" onPress={() => setApply(p)} style={{ alignSelf: 'flex-start' }} /> : null}
        </ACard>
      ))}
      {apply ? <OfferForm visible onClose={() => setApply(null)} pkg={{ ...apply, platforms: apply.platforms, countries: apply.countries }} partner={partner} onDone={() => { d.reload(); onChanged(); }} /> : null}
    </>
  );
}
