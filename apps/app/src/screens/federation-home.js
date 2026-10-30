// Federation & Governing Body OS (#475): Federation Home. The workspace shell (hero, tabs, roll-up switch) and the Overview: what needs the body's
// attention now, read from the canonical records. The other tabs live in federation-lists.js (registers) and federation-gov.js (calendar, policies, reports, setup).
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { Card, Empty, H1, Loading, Screen, Section, Seg, T, Tag } from '../ui';
import { LoadError } from '../access';
import { c } from '../theme';
import { Banner, Metric, StatusTag, fmtDate, fmtRange } from '../federation-ui';
import { Bar, Cols, Hero, ListCard, SwitchRow } from '../federation-bits';
import { RegisterTab } from './federation-lists';
import { CalendarTab, PoliciesTab, ReportsTab, SetupTab } from './federation-gov';
import { CampaignsTab, ComplianceTab } from './federation-admin';
import { OfficialsTab } from './officials-body';
import { IntegrityTab } from './integrity';

function Overview({ home, go, push }) {
  const n = home.counts;
  const Q = ({ title, rows, type, empty }) => (
    <Section title={title} color={c.sun}>
      {rows.length ? rows.map((r) => <ListCard key={r.id} title={r.label} sub={r.sub} status={r.status} onPress={() => push('FederationRecord', { type, id: r.id })} />) : <Empty emoji="✅" title={empty} />}
    </Section>);
  const maxSport = Math.max(1, ...home.breakdown.by_sport.map((s) => s.affiliations + s.licences + s.sanctions));
  return (
    <View style={{ gap: 4 }}>
      {n.link_requests ? <Banner action="Review" onAction={() => go('setup')}>{n.link_requests} recognition request{n.link_requests === 1 ? '' : 's'} between bodies waiting.</Banner> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 8 }}>
        <Metric value={n.affiliations.pending} label="Affiliations to review" sub={n.affiliations.needs_info ? `${n.affiliations.needs_info} with the club` : undefined} tone={n.affiliations.pending ? c.sunSoft : undefined} onPress={() => go('affiliations', { status: 'submitted' })} />
        <Metric value={n.affiliations.expiring_30} label="Affiliations ending in 30 days" sub={`${n.affiliations.approved} in force`} onPress={() => go('affiliations', { expiring: 30 })} />
        <Metric value={n.licences.pending} label="Licences to review" sub={n.licences.needs_info ? `${n.licences.needs_info} with the applicant` : undefined} tone={n.licences.pending ? c.sunSoft : undefined} onPress={() => go('licences', { status: 'submitted' })} />
        <Metric value={n.licences.expiring_30} label="Licences expiring in 30 days" sub={`${n.licences.active} in good standing`} onPress={() => go('licences', { expiring: 30 })} />
        <Metric value={n.sanctions.pending} label="Sanction requests" sub={`${n.sanctions.approved} sanctioned`} tone={n.sanctions.pending ? c.sunSoft : undefined} onPress={() => go('sanctions', { status: 'requested' })} />
        <Metric value={n.competitions.total} label="Competitions under jurisdiction" sub={`${n.competitions.unsanctioned_upcoming} upcoming without a sanction`} onPress={() => go('sanctions', { view: 'events' })} />
        <Metric value={n.exceptions} label="Compliance exceptions" onPress={() => go('compliance')} tone={n.exceptions ? c.orangeSoft : undefined} sub={n.sanctions.moved ? `${n.sanctions.moved} sanctioned event moved` : undefined} />
        <Metric value={n.cases} label="Open appeals" sub="linked to your records" />
      </View>

      <Cols
        a={<>
          <Q title="Affiliation queue" rows={home.queue.affiliations} type="affiliation" empty="No affiliation waiting" />
          <Q title="Licence queue" rows={home.queue.licences} type="licence" empty="No licence waiting" />
          <Q title="Sanction queue" rows={home.queue.sanctions} type="sanction" empty="No sanction request waiting" />
        </>}
        b={<>
          <Section title="Compliance exceptions" color={c.orange}>
            {home.exceptions.length ? home.exceptions.map((e) => (
              <ListCard key={`${e.type}${e.id}${e.kind}`} title={e.label} sub={e.reason} sub2={[e.kind === 'event_moved' ? 'Event moved' : e.overdue ? 'Review overdue' : `Review by ${fmtDate(e.review_due)}`, e.by, e.at ? fmtDate(e.at) : null].filter(Boolean).join(' · ')}
                tone={e.kind === 'event_moved' || e.overdue ? c.orangeSoft : undefined} onPress={() => push('FederationRecord', { type: e.type, id: e.id })} />)) : <Empty emoji="🛡️" title="No exceptions" sub="Every decision met its published requirements." />}
          </Section>
          <Section title="Registration and transfer windows" color={c.cyan}>
            {home.windows.length ? home.windows.map((w) => <ListCard key={w.id} title={w.title} sub={fmtRange(w.starts_on, w.ends_on)} status={w.open ? 'active' : 'pending'} statusLabel={w.open ? 'Open now' : 'Opens soon'} onPress={() => go('calendar')} />) : <Empty emoji="🗓️" title="No window open or coming" />}
          </Section>
          <Section title="Appeals and disputes" color={c.pink}>
            {home.cases.length ? home.cases.map((k) => <ListCard key={k.case_no} title={`Case #${k.case_no}`} sub={`${k.link_type} · ${k.category.replace(/_/g, ' ')}`} status={k.status === 'resolved' ? 'ended' : 'pending'} statusLabel={k.status.replace(/_/g, ' ')} />) : <Empty emoji="⚖️" title="No open appeals" sub="You can see that an appeal exists, never what the person wrote." />}
          </Section>
        </>} />

      <Section title="By sport" color={c.mint}>
        {home.breakdown.by_sport.length ? <Card color={c.paper}><View style={{ gap: 12 }}>{home.breakdown.by_sport.map((s) => <Bar key={s.sport_id} label={s.sport_name} value={s.affiliations + s.licences + s.sanctions} max={maxSport} sub={`${s.affiliations} affiliations · ${s.licences} licences · ${s.sanctions} sanctions`} />)}</View></Card> : <Empty emoji="📊" title="Nothing in force yet" />}
      </Section>
      <Cols
        a={<Section title="By season" color={c.sun}>
          {home.breakdown.by_season.length ? <Card color={c.paper}><View style={{ gap: 10 }}>{home.breakdown.by_season.map((s) => <View key={s.season_year} style={{ flexDirection: 'row', justifyContent: 'space-between' }} accessible accessibilityLabel={`${s.season_year}: ${s.affiliations} affiliations, ${s.licences} licences, ${s.sanctions} sanctions`}><T weight="700">{s.season_year}</T><T size={13} color={c.mute}>{s.affiliations} aff · {s.licences} lic · {s.sanctions} san</T></View>)}</View></Card> : <Empty emoji="📅" title="No seasons yet" />}
        </Section>}
        b={<Section title="By body" color={c.cyan}>
          {home.breakdown.by_region.map((r) => <ListCard key={r.body_id} title={r.name} sub={[r.level, r.region, r.state, r.district].filter(Boolean).join(' · ')} sub2={`${r.affiliations} affiliations · ${r.licences} licences · ${r.sanctions} sanctions`} onPress={r.body_id !== home.body.id ? () => push('FederationHome', { id: r.body_id }) : undefined} />)}
        </Section>} />
    </View>
  );
}

export function FederationHome({ id, tab: startTab }) {
  const { push } = useNav();
  const [below, setBelow] = useState(true);
  const [tab, setTab] = useState(startTab ?? 'overview');
  const [preset, setPreset] = useState({});
  const home = useLoad(() => api.get(`/federation/bodies/${id}/home`, { include_descendants: below }), [id, below]);
  const h = home.data;
  if (home.error && !h) return <Screen><H1>Federation</H1><LoadError error={home.error} onRetry={home.reload} /></Screen>;
  if (!h) return <Screen><Loading /></Screen>;
  const can = h.me.can;
  const go = (t, p = {}) => { setPreset(p); setTab(t); };
  const tabs = [
    { value: 'overview', label: 'Overview' }, { value: 'affiliations', label: 'Affiliations' }, { value: 'licences', label: 'Licences' }, { value: 'sanctions', label: 'Sanctions' },
    { value: 'officials', label: 'Officials' }, { value: 'campaigns', label: 'Campaigns' }, { value: 'compliance', label: 'Compliance' }, { value: 'calendar', label: 'Calendar' }, { value: 'policies', label: 'Policies' }, ...(can.reports ? [{ value: 'reports', label: 'Reports' }] : []), ...(can.integrity ? [{ value: 'integrity', label: 'Integrity' }] : []), { value: 'setup', label: 'Setup' },
  ];
  const shared = { id, home: h, me: h.me, below, preset, reloadHome: home.reload, go };
  return (
    <Screen refreshing={home.loading} onRefresh={home.reload} wide>
      <Hero body={h.body} me={h.me}>
        {h.body.status !== 'active' ? <T size={12} color="#fff" style={{ marginTop: 8 }}>This body is {h.body.status} and takes no new applications or decisions.</T> : null}
      </Hero>
      <View style={{ marginTop: 14, gap: 4 }}>
        <Seg options={tabs} value={tab} onChange={(t) => go(t)} />
        {(h.breakdown.by_region.length > 1 || !below) && ['overview', 'affiliations', 'licences', 'sanctions', 'calendar', 'compliance'].includes(tab)
          ? <SwitchRow label="Include the bodies recognised below this one" sub={`${h.scope.bodies} bod${h.scope.bodies === 1 ? 'y' : 'ies'} in view`} value={below} onChange={setBelow} /> : null}
      </View>
      <View style={{ marginTop: 8 }}>
        {tab === 'overview' ? <Overview home={h} go={go} push={push} /> : null}
        {['affiliations', 'licences', 'sanctions'].includes(tab) ? <RegisterTab key={tab} kind={tab} {...shared} /> : null}
        {tab === 'officials' ? <OfficialsTab id={id} below={below} me={h.me} /> : null}
        {tab === 'campaigns' ? <CampaignsTab {...shared} /> : null}
        {tab === 'compliance' ? <ComplianceTab {...shared} /> : null}
        {tab === 'calendar' ? <CalendarTab {...shared} /> : null}
        {tab === 'policies' ? <PoliciesTab {...shared} /> : null}
        {tab === 'reports' ? <ReportsTab {...shared} /> : null}
        {tab === 'integrity' && can.integrity ? <IntegrityTab id={id} /> : null}
        {tab === 'setup' ? <SetupTab {...shared} /> : null}
      </View>
    </Screen>
  );
}
