// The venue owner's home. A new venue user (no venue yet, or one that is not ready for bookings) lands on the registration wizard
// with the Find coach / Find supplier / Tender zone cards; once a venue is open the home is the command centre: today, what needs
// attention, live facilities, bookings and events, money, demand, suppliers, upkeep, people, customers and compliance.
// Everything comes from GET /venues/:id/command-centre; the wizard reuses the venue form (venue-register.js) and the guided setup.
import React, { useMemo, useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { useLayout } from '../layout';
import { Btn, Card, ErrorBox, HScroll, Loading, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { MenuField } from '../menu-field';
import { Stepper } from '../pickers';
import { c } from '../theme';
import { t } from '../i18n';
import { locale } from '../locale';
import { SetupWizard } from './venue-setup';
import { venueFormProps } from './venue-register';
import { AiManager, AttentionList, AssetsAndStaff, BookingsAndEvents, Block, Compliance, Customer, Demand, FacilityTimeline, KpiRow, Opportunities, Procurement, RevenueOccupancy, insightText } from './venue-hub-sections';

const STEPS = () => [t('vh.step.venue'), t('vh.step.courts'), t('vh.step.prices'), t('vh.step.timetable'), t('vh.step.seating'), t('vh.step.finish')];

/** Find a coach, Find a supplier, Tender zone: each opens the screen that already does the job. */
export function FindCards({ venueId }) {
  const { push, goTab } = useNav();
  const { tablet } = useLayout();
  const cards = [
    { icon: '🧑‍🏫', title: t('vh.find.coach'), sub: t('vh.find.coach_sub'), onPress: () => goTab('Schedule', { section: 'coach' }) },
    { icon: '🧰', title: t('vh.find.supplier'), sub: t('vh.find.supplier_sub'), onPress: () => (venueId ? push('ServicesBuyer', { venue_id: venueId }) : push('Marketplace')) },
    { icon: '📑', title: t('vh.find.tender'), sub: t('vh.find.tender_sub'), onPress: () => push('TenderZone') },
  ];
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
      {cards.map((x) => (
        <Card key={x.title} onPress={x.onPress} pad={14} accessibilityLabel={[x.title, x.sub].join('. ')} style={{ flexGrow: 1, flexBasis: tablet ? 220 : '100%', minHeight: 88, gap: 4 }}>
          <T weight="800" size={16}>{x.icon} {x.title}</T>
          <T size={13} color={c.mute}>{x.sub}</T>
        </Card>
      ))}
    </View>
  );
}

/** Registration wizard on the landing page: venue basics inline, then the guided setup (courts, prices, timetable, seating, finish). */
function VenueWizard({ venue, onChanged }) {
  const { push } = useNav();
  const [created, setCreated] = useState(null);
  const id = venue?.id ?? created?.id;
  const full = useLoad(() => (id ? api.get(`/venues/${id}`) : Promise.resolve(null)), [id]);
  const props = useMemo(() => venueFormProps(async (x) => { setCreated(x); await onChanged?.(); }), [onChanged]);
  return (
    <Card pad={16} style={{ borderColor: c.pink, borderWidth: 1 }}>
      <T size={12} weight="800" color={c.pink}>{t('vh.wiz.eyebrow').toUpperCase()}</T>
      <T size={22} weight="800">{id ? t('vh.wiz.continue', { name: venue?.name ?? created?.name ?? '' }) : t('vh.wiz.title')}</T>
      <T color={c.mute} size={13} style={{ marginTop: 2 }}>{id ? t('vh.wiz.continue_sub') : t('vh.wiz.sub')}</T>
      {!id ? <>
        <Stepper steps={STEPS()} current={0} />
        <FormSheet inline onClose={() => {}} {...props} />
      </> : full.error ? <ErrorBox error={full.error} onRetry={full.reload} /> : !full.data ? <Loading /> : (
        <SetupWizard v={full.data} start={0} goTab={(tab) => push('Manage', { id, tab })} onExit={() => { setCreated(null); onChanged?.(); }} />
      )}
    </Card>
  );
}

function NewVenueHome({ venue, onChanged }) {
  return (
    <View style={{ gap: 16 }}>
      <VenueWizard venue={venue} onChanged={onChanged} />
      <View>
        <T size={17} weight="800" style={{ marginBottom: 4 }}>{t('vh.find.title')}</T>
        <T size={13} color={c.mute} style={{ marginBottom: 10 }}>{t('vh.find.sub')}</T>
        <FindCards venueId={venue?.id} />
      </View>
    </View>
  );
}

function Header({ d, venues, venueId, setVenueId, go }) {
  const date = (() => { try { return new Date(`${d.today?.date ?? ''}T12:00:00Z`).toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }); } catch { return ''; } })();
  const pending = venues.find((v) => v.id === venueId)?.approval_status;
  const actions = [
    [t('vh.qa.booking'), { route: 'Manage', params: { id: d.venue.id, tab: 'frontdesk' } }],
    [t('vh.qa.block'), { route: 'Manage', params: { id: d.venue.id, tab: 'blocks' } }],
    [t('vh.qa.event'), { route: 'EventsWorkspace' }],
    [t('vh.qa.facility'), { route: 'Manage', params: { id: d.venue.id, tab: 'pricing' } }],
    [t('vh.qa.maintenance'), { route: 'Manage', params: { id: d.venue.id, tab: 'maintenance' } }],
    [t('vh.qa.rfp'), { route: 'TenderBuilder', params: { venue_id: d.venue.id } }],
  ];
  return (
    <View style={{ gap: 8 }}>
      <T size={12} weight="800" color={c.mute}>{date.toUpperCase()}</T>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <T size={26} weight="800" style={{ flexShrink: 1 }}>{d.venue.name}</T>
        <Tag label={t(`vh.open.${d.today?.status ?? 'closed'}`)} color={d.today?.status === 'open' ? c.mint : c.violetSoft} />
        {pending && pending !== 'approved' ? <Tag label={t(`vh.approval.${pending}`)} color={c.sun} /> : null}
      </View>
      {venues.length > 1 ? <MenuField label={t('vh.venue')} value={venueId} onChange={setVenueId} options={venues.map((v) => ({ value: v.id, label: v.name, sub: v.city }))} /> : null}
      <HScroll>
        {actions.map(([label, a]) => <Btn key={label} small title={label} color={c.paper} onPress={() => go(a)} />)}
      </HScroll>
    </View>
  );
}

function Dashboard({ venues, venueId, setVenueId, setup }) {
  const { push } = useNav();
  const { tablet } = useLayout();
  const cc = useLoad(() => api.get(`/venues/${venueId}/command-centre`), [venueId]);
  const [review, setReview] = useState(false);
  const go = (a) => { if (!a) return; setReview(false); push(a.route, a.params ?? {}); };
  if (cc.error) return <ErrorBox error={cc.error} onRetry={cc.reload} />;
  if (!cc.data) return <Loading />;
  const d = cc.data;
  return (
    <View>
      <Header d={d} venues={venues} venueId={venueId} setVenueId={setVenueId} go={go} />
      <View style={{ marginTop: 14 }}><KpiRow d={d} onActions={() => setReview(true)} /></View>
      <View style={{ marginTop: 14 }}><AiManager d={d} onReview={() => setReview(true)} /></View>
      <Block title={t('vh.sec.attention')}><AttentionList items={d.attention} go={go} limit={6} /></Block>
      <Block title={t('vh.sec.facilities')}><FacilityTimeline d={d} go={go} /></Block>
      <Block title={t('vh.sec.bookings')}><BookingsAndEvents d={d} go={go} /></Block>
      <Block title={t('vh.sec.revenue')}><RevenueOccupancy d={d} go={go} /></Block>
      <Block title={t('vh.sec.opportunities')}><Opportunities d={d} go={go} /></Block>
      <Block title={t('vh.sec.demand')}><Demand d={d} go={go} /></Block>
      <Block title={t('vh.sec.procurement')} action={t('vh.find.tender')} onAction={() => push('TenderZone')}><Procurement d={d} go={go} /></Block>
      <Block title={t('vh.sec.upkeep')}><AssetsAndStaff d={d} go={go} /></Block>
      <Block title={t('vh.sec.customers')}><Customer d={d} go={go} /></Block>
      <Block title={t('vh.sec.compliance')}><Compliance d={d} go={go} /></Block>
      <Block title={t('vh.sec.find')}><FindCards venueId={d.venue.id} /></Block>
      <Block title={t('vh.sec.inbox')} action={t('vh.inbox.open')} onAction={() => push('Inbox')}>
        <Card pad={12} onPress={() => push('Inbox')} accessibilityLabel={t('vh.inbox.unread', { n: d.inbox?.unread ?? 0 })}><T weight="700">{t('vh.inbox.unread', { n: d.inbox?.unread ?? 0 })}</T><T size={12} color={c.mute}>{t('vh.inbox.sub')}</T></Card>
      </Block>
      {setup && !setup.ready ? (
        <Card pad={12} onPress={() => push('Manage', { id: d.venue.id, tab: 'setup' })} accessibilityLabel={(setup.total - setup.done === 1 ? t('vh.setup.left_one') : t('vh.setup.left', { n: setup.total - setup.done }))} style={{ marginTop: 22 }}>
          <T weight="700">{(setup.total - setup.done === 1 ? t('vh.setup.left_one') : t('vh.setup.left', { n: setup.total - setup.done }))}</T><T size={12} color={c.mute}>{t('vh.setup.sub')}</T>
        </Card>
      ) : null}
      {d.unavailable.length ? <T size={12} color={c.mute} style={{ marginTop: 12 }}>{(d.unavailable.length === 1 ? t('vh.partial_one') : t('vh.partial', { n: d.unavailable.length }))}</T> : null}
      <Sheet visible={review} onClose={() => setReview(false)} title={t('vh.ai.review')}>
        <View style={{ gap: 12 }}>
          <AttentionList items={d.attention} go={go} />
          {d.insights.map((x) => <Card key={x.key} pad={12}><T>💡  {insightText(x)}</T></Card>)}
        </View>
      </Sheet>
    </View>
  );
}

/** Venue owner home: the wizard for a venue that is not open yet, the command centre once it is. */
export function VenueHub() {
  const venues = useLoad(() => api.get('/me/venues'), []);
  const managed = (venues.data ?? []).filter((v) => v.role === 'owner' || v.role === 'manager');
  const [picked, setPicked] = useState(null);
  const venueId = picked && managed.some((v) => v.id === picked) ? picked : managed[0]?.id;
  const setup = useLoad(() => (venueId ? api.get(`/venues/${venueId}/setup`) : Promise.resolve(null)), [venueId]);
  if (venues.error) return <ErrorBox error={venues.error} onRetry={venues.reload} />;
  if (!venues.data || (venueId && !setup.data && !setup.error)) return <Loading />;
  const reload = async () => { await venues.reload(); await setup.reload(); };
  const open = ['courts', 'timetable', 'pricing'].every((k) => setup.data?.steps.find((x) => x.key === k)?.done); // bookable; the rest of setup is a quiet reminder, not the front door
  if (!venueId || (setup.data && !open)) return <NewVenueHome venue={managed.find((v) => v.id === venueId)} onChanged={reload} />;
  return <Dashboard venues={managed} venueId={venueId} setVenueId={setPicked} setup={setup.data} />;
}
