import { OfflineSync } from './screens/offline-sync';
import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Platform, Pressable, StatusBar, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { SessionProvider, useSession } from './session';
import { NavProvider, useNav } from './nav';
import { Btn, Loading } from './ui';
import { Icon } from './icons';
import { useLayout } from './layout';
import { installWebShell } from './web';
import { api, setMfaRequiredHandler } from './api';
import { parseTarget, targetFor } from './push';
import { AccountButton } from './account';
import { BetaBanner } from './beta-banner';
import { Logo } from './logo';
import { c, dark, fam } from './theme';

installWebShell();
import Home from './screens/feed';
import Landing from './screens/landing';
import { Explore, Event, Team, Person } from './screens/play';
import { Following, LiveCentre, PublicShell } from './screens/spectate';
import { TeamManage } from './screens/team-manage';
import { TeamWorkspace } from './screens/team-workspace';
import { TeamChat } from './screens/team-chat';
import { Venue } from './screens/book';
import { Schedule } from './screens/schedule';
import { BookFlow } from './screens/bookflow';
import { Billboard, Insure } from './screens/marketplace';
import { FindGames } from './screens/find-games';
import { OpenGame } from './screens/open-game';
import { TenderNotice, SupplierEntities, TenderZonePage } from './screens/tender-zone';
import { TenderProposal, TenderProposals } from './screens/tender-proposal';
import { TenderBuilder } from './screens/tender-builder';
import { TenderConsole, TenderHome } from './screens/tender-console';
import { TenderOrders, TenderOrder, TenderReports } from './screens/tender-orders';
import { MyApplications, RecruitmentApplication, RecruitmentPipeline } from './screens/recruitment';
import { OpportunityMatches } from './screens/opportunity-matches';
import { Shop, ShopProduct, ShopCart, ShopOrders } from './screens/shop';
import { Basket, Reservation, Compare, Notifications, Invoice } from './screens/reserve';
import { Manage, OwnerSummary } from './screens/manage';
import { VenueWorkspace } from './screens/venue-workspace';
import { Wallet } from './screens/wallet';
import { Rewards, RewardsConsole } from './screens/rewards';
import { Earnings } from './screens/earnings';
import { PlayerContracts } from './screens/player-contracts';
import { BasketProvider } from './basket';
import { Leaderboard, Awards, Health, Sponsors, Supply } from './screens/hub';
import { SponsorDeal } from './screens/sponsor-deal';
import { SponsorOffer } from './screens/sponsor-offer';
import { ApplicationForm } from './screens/sponsor-application';
import { FormBuilder } from './screens/sponsor-form-builder';
import { SponsorPortfolio, PortfolioEntry } from './screens/sponsor-portfolio';
import { PlayerFunding } from './screens/player-funding';
import { SponsorIdentity } from './screens/sponsor-identity';
import { SponsorReports } from './screens/sponsor-reports';
import { SponsorPrograms, SponsorProgram, FundingOpportunities, SponsorCall } from './screens/sponsor-programs';
import { SponsorBudgets, SponsorBudget } from './screens/sponsor-budgets';
import { Insurance, InsurerPage } from './screens/insurance';
import { InsurerDesk } from './screens/insurer';
import { BrandedDocuments } from './screens/branded-documents';
import { PartnerConsole, MyPartner } from './screens/partners';
import { CommercialConsole } from './screens/commercial-console';
import { Me } from './screens/me';
import { Support } from './screens/cases';
import { Family } from './screens/family';
import { Orgs, Org } from './screens/org';
import { Federations, FederationHome, FederationRecord, VerifyLicence } from './screens/federation';
import { MediaWorkspace } from './screens/media-workspace';
import { OrgAffiliations, MyLicences } from './screens/federation-club';
import { OfficialsDevelopment } from './screens/officials-development';
import { OfficialsHome, OfficialMatch } from './screens/officials-home';
import { OfficialAssessment, AssessmentEditor } from './screens/officials-assessment';
import { AcademyFamily } from './screens/academy-portal';
import { Trials } from './screens/trials';
import { AcademySession, AcademyAgenda } from './screens/academy-session';
import { Pathways, Programme, Institution, Enquiry } from './screens/pathways';
import { PathwayPlan, SharedPathway } from './screens/pathway-plan';
import { Games } from './screens/games';
import { RaceDesk } from './screens/race-desk';
import { RaceLive } from './screens/race-live';
import { EventInbox } from './screens/event-plan';
import { Openings } from './screens/openings';
import { EventCommand } from './screens/event-command';
import { MatchCentre } from './screens/match-centre';
import { ScoreSheet } from './screens/score-sheet';
import { DoctorHome } from './screens/doctor';
import { LegalHome } from './screens/legal';
import { SharedWellness, ChildWellnessSharing } from './screens/wellness-sharing';
import { SeasonReports, ChildSeasonReports, SharedSeasonReports } from './screens/season-reports';
import { CoachHome, CoachAthletes, CoachPlan, CoachCalendar, MyPlans } from './screens/coach';
import { MyDevelopment } from './screens/player-development';
import { PlayerAssistant } from './screens/player-assistant';
import { PerformanceStudio, CoachSession, CoachJournal, CoachGoals, CoachCopilot, CoachReports, CoachReport, CoachReportView, CoachMatch, CoachProgrammes, CoachRubrics } from './screens/coaching-studio';
import { CoachProfile, CoachRequest, CoachBoard, CoachDesk, CoachSetup } from './screens/coaching';
import { CoachRates, CoachCommitments, CoachReviews, CoachAnalytics } from './screens/coach-business';
import { SupplierWorkspace } from './screens/svc-supplier';
import { ServicesBuyer } from './screens/svc-buyer';
import { TrainingVenue, RecurringVenue } from './screens/training-venue';

import { PlayerHome, SportProfile, ImportMatches } from './screens/player';
import { MyPassport, PassportDesk, PassportPublic } from './screens/passport';
import { GateScan, MyAccreditations } from './screens/event-accreditation';
import { TripsHome, Trip } from './screens/trips';
import { MyCardsPage, MyPassesPage } from './screens/my-passes';
import { ToolsHome } from './screens/tools';
import { ScoringTool } from './screens/scoring-tool';
import { SportRules } from './screens/sport-rules';
import { CareerTimeline } from './screens/career';
import { RecruiterHome, RecruiterAccess } from './screens/recruiter';
import { MoreWheel } from './screens/more-wheel';
import { Glass } from './glass';

// A coach or scout opening a passport link (web) sees the athlete's CV without signing in.
const PASSPORT_TOKEN = Platform.OS === 'web' && typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('passport') : null;

// A shared event or game link (web): signed-out visitors see the public page; signed-in people are taken to the same screens inside the app.
const PUBLIC_LINK = (() => {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null;
  const q = new URLSearchParams(window.location.search);
  const ok = (v) => (v && /^[0-9a-f-]{36}$/i.test(v) ? v : null);
  const event = ok(q.get('event')), fixture = ok(q.get('fixture'));
  return event || fixture ? { event, fixture } : null;
})();

const TABS = [['Home', Home], ['Explore', Explore], ['Schedule', Schedule], ['Player', PlayerHome], ['Me', Me]];
const PAGES = { Trips: TripsHome, Trip, OfficialsHome, OfficialMatch, Rewards, RewardsConsole, MyPasses: MyPassesPage, MyCards: MyCardsPage, CommercialConsole, FindGames, OpenGame, Following, LiveCentre, GateScan, MyAccreditations, OfficialsDevelopment, OfficialAssessment, AssessmentEditor, MediaWorkspace, Federations, FederationHome, FederationRecord, VerifyLicence, OrgAffiliations, MyLicences, SupplierWorkspace, VenueWorkspace, ServicesBuyer, SeasonReports, ChildSeasonReports, SharedSeasonReports, PlayerFunding, SharedWellness, ChildWellnessSharing, PlayerContracts, OfflineSync, PathwayPlan, SharedPathway, SponsorIdentity, OpportunityMatches, ToolsHome, ScoringTool, SportRules, MyApplications, RecruitmentApplication, RecruitmentPipeline, Trials, RecruiterHome, RecruiterAccess, AcademySession, AcademyAgenda, CareerTimeline, SponsorReports, SponsorBudgets, SponsorBudget, BrandedDocuments, Billboard, Shop, ShopProduct, ShopCart, ShopOrders, Insure, Pathways, Programme, Institution, Enquiry, Passport: MyPassport, PassportDesk, Event, PartnerConsole, MyPartner, Team, TeamManage, TeamWorkspace, TeamChat, Person, Venue, Wallet, Earnings, BookFlow, Invoice, Basket, Reservation, Compare, Notifications, Manage, OwnerSummary, Leaderboard, Awards, Health, DoctorHome, Legal: LegalHome, Insurance, InsurerPage, InsurerDesk, Sponsors, SponsorDeal, SponsorOffer, SponsorPortfolio, PortfolioEntry, SponsorPrograms, SponsorProgram, FundingOpportunities, SponsorCall, ApplicationForm, FormBuilder, Supply, SportProfile, ImportMatches, Support, Family, CoachHome, CoachAthletes, CoachPlan, CoachCalendar, MyPlans, PerformanceStudio, CoachSession, CoachJournal, CoachGoals, MyDevelopment, PlayerAssistant, CoachCopilot, CoachReports, CoachReport, CoachReportView, CoachMatch, CoachProgrammes, CoachRubrics, Orgs, Org, AcademyFamily, Games, RaceDesk, RaceLive, EventInbox, Openings, CoachProfile, CoachRequest, CoachBoard, CoachDesk, CoachSetup, CoachRates, CoachCommitments, CoachReviews, CoachAnalytics, TrainingVenue, RecurringVenue, EventCommand, MatchCentre, ScoreSheet, TenderNotice, SupplierEntities, TenderProposal, TenderProposals, TenderBuilder, TenderConsole, TenderHome, TenderOrders, TenderOrder, TenderReports, TenderZone: TenderZonePage };
const TITLES = { Trips: 'Trips', Trip: 'Trip', OfficialsHome: 'Officials home', OfficialMatch: 'Match briefing', Rewards: 'Rewards', RewardsConsole: 'Rewards & referrals', MyPasses: 'My passes', MyCards: 'Cards and wristbands', CommercialConsole: 'Commercial', FindGames: 'Find a game', OpenGame: 'Game', Following: 'Following', LiveCentre: 'Live game', GateScan: 'Gate scanner', MyAccreditations: 'My badges', OfficialsDevelopment: 'Officials development', OfficialAssessment: 'Assessment', AssessmentEditor: 'Assessment report', MediaWorkspace: 'Media & broadcast', Federations: 'Federations', FederationHome: 'Federation', FederationRecord: 'Federation record', VerifyLicence: 'Check a licence', OrgAffiliations: 'Federation affiliations', MyLicences: 'My licences', VenueWorkspace: 'Venue workspace', SupplierWorkspace: 'Supplier workspace', ServicesBuyer: 'Services & suppliers', SeasonReports: 'Season & career reports', ChildSeasonReports: 'Season & career reports', SharedSeasonReports: 'Shared reports', PlayerFunding: 'Funding', SharedWellness: 'Shared wellness', ChildWellnessSharing: 'Wellness sharing', PlayerContracts: 'Contracts', OfflineSync: 'Offline & sync', PathwayPlan: 'Pathway plan', SharedPathway: 'Athlete pathway', SponsorIdentity: 'Team & identity', OpportunityMatches: 'Opportunities for me', PassportDesk: 'Recruitment', ToolsHome: 'Tools', ScoringTool: 'Scoring & tracking', SportRules: 'Rules & rulebook', MyApplications: 'My applications', RecruitmentApplication: 'Application', RecruitmentPipeline: 'Recruiting', Trials: 'Trials', RecruiterHome: 'Recruiter workspace', RecruiterAccess: 'Recruiter access', AcademySession: 'Academy session', AcademyAgenda: 'Academy week', CareerTimeline: 'Career timeline', SponsorReports: 'Sponsorship reports', SponsorBudgets: 'Sponsorship budgets', SponsorBudget: 'Budget', BrandedDocuments: 'Document designer', Billboard: 'Billboard', Shop: 'Shop', ShopProduct: 'Product', ShopCart: 'Cart', ShopOrders: 'Orders', Insure: 'My cover', Pathways: 'Learn & study sport', Programme: 'Programme', Institution: 'Institution', Enquiry: 'Enquiry', Passport: 'Player passport', Event: 'Event', PartnerConsole: 'Partner management', MyPartner: 'Partner account', Team: 'Team', TeamManage: 'Manage team', TeamWorkspace: 'Team workspace', TeamChat: 'Team chat', Person: 'Profile', Venue: 'Venue', Wallet: 'Wallet', Earnings: 'Earnings', BookFlow: 'Book', Invoice: 'Invoice', Basket: 'Basket', Reservation: 'Booking', Compare: 'Compare', Notifications: 'Notifications', Manage: 'Manage venue', OwnerSummary: 'All my venues', Leaderboard: 'Leaderboard', Awards: 'Trophy room', Health: 'Health', DoctorHome: 'Doctor workspace', Legal: 'Legal', Insurance: 'Insurance', InsurerPage: 'Insurer', InsurerDesk: 'Insurer desk', Sponsors: 'Sponsor home', SponsorDeal: 'Sponsorship agreement', SponsorOffer: 'New offer', SponsorPortfolio: 'Beneficiary portfolio', PortfolioEntry: 'Beneficiary', SponsorPrograms: 'Sponsorship programs', SponsorProgram: 'Program', FundingOpportunities: 'Sponsorship calls', SponsorCall: 'Sponsorship call', ApplicationForm: 'Application', FormBuilder: 'Application forms', Supply: 'Supply chain', SportProfile: 'Sport profile', ImportMatches: 'Import matches', Support: 'Support', Family: 'Family & guardians', CoachHome: 'Coach home', CoachAthletes: 'My athletes', CoachPlan: 'Training plan', CoachCalendar: 'Coach calendar', PerformanceStudio: 'Performance Studio', CoachSession: 'Coaching session', CoachJournal: 'Coaching journal', CoachGoals: 'Goals & actions', MyDevelopment: 'My development', PlayerAssistant: 'Assistant', CoachCopilot: 'AI draft', CoachReports: 'Reports', CoachReport: 'Report', CoachReportView: 'Report', CoachMatch: 'Match', CoachProgrammes: 'Programmes', CoachRubrics: 'Rubrics', MyPlans: 'Training plans', Orgs: 'My organisations', Org: 'Organisation', AcademyFamily: 'My academy', Games: 'Games programme', RaceDesk: 'Race day', RaceLive: 'Race results', EventInbox: 'Event requests', Openings: 'Open positions', CoachProfile: 'Coach', CoachRequest: 'Coaching request', CoachBoard: 'Request board', CoachDesk: 'Coach desk', CoachSetup: 'Profile & hours', CoachRates: 'Rate cards', CoachCommitments: 'Commitments', CoachReviews: 'Reviews', CoachAnalytics: 'Analytics', TrainingVenue: 'Court for coaching', RecurringVenue: 'Recurring booking', EventCommand: 'Event console', MatchCentre: 'Live match', ScoreSheet: 'Score sheet', TenderNotice: 'Tender', SupplierEntities: 'Supplier entities', TenderProposal: 'Proposal', TenderProposals: 'My proposals', TenderBuilder: 'RFP builder', TenderConsole: 'Tender console', TenderHome: 'My RFPs', TenderOrders: 'Orders', TenderOrder: 'Order', TenderReports: 'Tender reports', TenderZone: 'Tender zone' };

const TAB_LABEL = { Hub: 'More' };
// Home: feed, reminders, jobs · Explore: find events, teams, people · More (raised centre): everything around the game
// Schedule: create, book, track and manage · Player: matches, scores and AI insights. Me opens from the hero avatar and from More.
const BAR = ['Home', 'Explore', 'Hub', 'Schedule', 'Player'];

/** Bottom tab bar. Phone: edge-to-edge bar. Tablet / large screens: a floating pill, like an iPad app. */
function TabBar() {
  const { tab, goTab, menu, toggleMenu } = useNav();
  const ins = useSafeAreaInsets();
  const { tablet, width } = useLayout();
  const items = BAR.map((name) => {
    const on = name === 'Hub' ? menu || tab === 'Me' : !menu && tab === name;
    const centre = name === 'Hub';
    return (
      <Pressable key={name} accessibilityRole="tab" accessibilityLabel={name === 'Hub' && menu ? 'Close More' : TAB_LABEL[name] ?? name} accessibilityState={{ selected: on, expanded: name === 'Hub' ? menu : undefined }} onPress={() => (name === 'Hub' ? toggleMenu() : goTab(name))} style={({ pressed }) => ({ flex: 1, alignItems: 'center', justifyContent: 'flex-end', minHeight: 52, opacity: pressed ? 0.6 : 1 })}>
        {centre ? (
          <View style={{ width: 56, height: 56, marginTop: -24, borderRadius: 28, ...(Platform.OS === 'web' ? { boxShadow: '0 10px 24px rgba(132,88,179,0.45), inset 1.5px 1.5px 0 rgba(255,255,255,0.7), inset -1px -1px 0 rgba(255,255,255,0.25)' } : { shadowColor: '#8458B3', shadowOpacity: 0.45, shadowRadius: 14, shadowOffset: { width: 0, height: 8 }, elevation: 8, borderWidth: 1, borderColor: 'rgba(255,255,255,0.6)' }) }}>
            <LinearGradient colors={['#9B72C6', '#494D5F']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
              <LinearGradient pointerEvents="none" colors={['rgba(255,255,255,0.5)', 'rgba(255,255,255,0)']} start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }} style={{ position: 'absolute', left: 0, right: 0, top: 0, height: '50%' }} />
              <Icon name={menu ? 'Close' : name} on color="#fff" size={26} />
            </LinearGradient>
          </View>
        ) : (
          <Glass radius={16} preset="clear" gloss={on} style={{ alignItems: 'center', justifyContent: 'center', paddingHorizontal: tablet ? 18 : 14, paddingVertical: 5, ...(on ? null : { backgroundColor: 'transparent', borderWidth: 0, boxShadow: 'none', backdropFilter: 'none', WebkitBackdropFilter: 'none' }) }}>
            <Icon name={name} on={on} color={on ? c.pink : c.mute} size={tablet ? 26 : 23} />
          </Glass>
        )}
        <Text numberOfLines={1} style={[fam, { fontSize: tablet ? 12 : 10.5, fontWeight: on ? '700' : '600', color: on ? c.pink : c.mute, marginTop: 2, marginBottom: 2 }]}>{TAB_LABEL[name] ?? name}</Text>
      </Pressable>
    );
  });
  return (
    <View pointerEvents="box-none" style={{ position: 'absolute', left: 0, right: 0, bottom: Math.max(ins.bottom, 12), alignItems: 'center' }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', width: Math.min(620, width - 24), paddingHorizontal: 8, paddingVertical: 6 }}>
        <Glass pointerEvents="none" radius={32} blur={20} tint={dark ? 'rgba(24,26,47,0.68)' : 'rgba(255,255,255,0.72)'} gloss iris style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }} />
        {items}
      </View>
    </View>
  );
}

// Module screens that open with a ModuleHero: the NavBar floats over the hero (back + account) instead of taking its own row.
const HERO_ROUTES = new Set(['Awards']);
function NavOverlay({ onBack, backLabel }) {
  const { gutter, contentMax } = useLayout();
  return (
    <View pointerEvents="box-none" style={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 5 }}>
      <View pointerEvents="box-none" style={{ width: '100%', maxWidth: contentMax, alignSelf: 'center', height: 56, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: gutter + 10, paddingTop: 8 }}>
        <Pressable onPress={onBack} hitSlop={10} accessibilityRole="button" accessibilityLabel={`Back to ${backLabel}`} style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
          <Glass radius={20} blur={10} tint="rgba(255,255,255,0.2)" gloss iris style={{ width: 40, height: 40, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="Back" color="#fff" size={24} />
          </Glass>
        </Pressable>
        <AccountButton />
      </View>
    </View>
  );
}

/** Compact navigation bar for pushed screens: back chevron + title. */
function NavBar({ title, onBack, backLabel }) {
  const { gutter, contentMax } = useLayout();
  return (
    <View style={{ backgroundColor: c.bg }}>
      <View style={{ width: '100%', maxWidth: contentMax, alignSelf: 'center', height: 48, flexDirection: 'row', alignItems: 'center', paddingHorizontal: gutter - 6 }}>
        <Pressable onPress={onBack} hitSlop={12} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', minWidth: 72, height: 44, opacity: pressed ? 0.5 : 1 })}>
          <Icon name="Back" color={c.pink} size={26} />
          <Text numberOfLines={1} style={[fam, { color: c.pink, fontSize: 16, fontWeight: '600', marginLeft: -2, maxWidth: 64 }]}>{backLabel}</Text>
        </Pressable>
        <Text numberOfLines={1} style={[fam, { position: 'absolute', left: 112, right: 112, textAlign: 'center', fontWeight: '700', fontSize: 16, color: c.ink }]} pointerEvents="none">{title}</Text>
        <View style={{ marginLeft: 'auto' }}><AccountButton /></View>
      </View>
    </View>
  );
}

/** Slim bar above the tab screens so the account menu (and Log out) is always one tap away. */
function TopBar() {
  const { gutter, contentMax } = useLayout();
  return (
    <View style={{ backgroundColor: c.bg }}>
      <View style={{ width: '100%', maxWidth: contentMax, alignSelf: 'center', height: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: gutter }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Logo size={34} />
          <Text style={[fam, { fontSize: 18, fontWeight: '800', color: c.ink, letterSpacing: -0.4 }]}>Gotmygame</Text>
        </View>
        <AccountButton />
      </View>
    </View>
  );
}

/** Screen change: tabs cross-fade, pushed screens slide in from the right (like a native stack). */
function Transition({ id, push, children }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    v.setValue(0);
    Animated.timing(v, { toValue: 1, duration: push ? 260 : 160, easing: Easing.out(Easing.cubic), useNativeDriver: Platform.OS !== 'web' }).start();
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Animated.View style={{ flex: 1, opacity: v, transform: [{ translateX: push ? v.interpolate({ inputRange: [0, 1], outputRange: [36, 0] }) : 0 }, { translateY: push ? 0 : v.interpolate({ inputRange: [0, 1], outputRange: [6, 0] }) }] }}>
      {children}
    </Animated.View>
  );
}

/** Shown when the API says this role must set up (or confirm) two-step verification before a health/admin action. */
function MfaNotice({ info, onGo, onClose }) {
  const { gutter, contentMax } = useLayout();
  const enrol = info.code === 'mfa_enrollment_required';
  return (
    <View accessibilityRole="alert" style={{ backgroundColor: c.orangeSoft, borderBottomWidth: 1, borderColor: c.line }}>
      <View style={{ width: '100%', maxWidth: contentMax, alignSelf: 'center', paddingHorizontal: gutter, paddingVertical: 10 }}>
        <Text style={[fam, { fontWeight: '700', color: c.ink }]}>{enrol ? 'Set up two-step verification to continue' : 'Confirm your two-step verification to continue'}</Text>
        <Text style={[fam, { color: c.mute, fontSize: 13, marginTop: 2 }]}>{enrol ? 'Your role handles health or platform data, so this action needs two-step verification.' : 'Sign out and sign in again with your authenticator code (or a recovery code), then retry.'}</Text>
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 8 }}>
          <Btn small title={enrol ? 'Set up two-step verification' : 'Open account security'} onPress={onGo} />
          <Btn small title="Dismiss" onPress={onClose} color={c.mute} />
        </View>
      </View>
    </View>
  );
}

function Shell() {
  const { ready, user, toast } = useSession();
  const { tab, stack, back, goTab, push, menu } = useNav();
  const ins = useSafeAreaInsets();
  const [mfa, setMfa] = useState(null);
  useEffect(() => { setMfaRequiredHandler(setMfa); return () => setMfaRequiredHandler(() => {}); }, []);
  useEffect(() => { if (!user) setMfa(null); }, [user]);
  // Logging out (from any screen) starts the next session from Home, not from a leftover pushed screen.
  useEffect(() => { if (ready && !user) goTab('Home'); }, [ready, user]); // eslint-disable-line react-hooks/exhaustive-deps
  // Back from Stripe/PayPal checkout (web): ?payment=<id>&result=success|cancel
  useEffect(() => {
    if (Platform.OS !== 'web' || !user) return;
    const q = new URLSearchParams(window.location.search);
    const id = q.get('payment');
    if (!id) return;
    window.history.replaceState({}, '', window.location.pathname);
    goTab('Schedule');
    if (q.get('result') !== 'success') return toast('Payment cancelled — nothing was charged');
    api.post(`/payments/${id}/confirm`).then(async (r) => {
      toast(r.status === 'paid' ? 'Payment received ✓' : 'Payment is still processing — check back shortly');
      if (r.purpose_type === 'shop_checkout' || r.purpose_type === 'shop_order') push('ShopOrders');
      if (r.purpose_type === 'sponsorship_payment' && r.sponsorship_id) { goTab('Schedule'); push('SponsorDeal', { id: r.sponsorship_id }); }
      if (r.purpose_type === 'venue_invoice') { const inv = await api.get(`/invoices/${r.purpose_id}`).catch(() => null); if (inv) { goTab('Schedule'); push('Reservation', { id: inv.reservation_id }); } }
    }).catch((e) => toast(e.message));
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps
  // A tapped push notification opens the right screen: from the web service worker (?open= or a message) or from the phone.
  // Opening a shared link while signed in: straight to the event or the live game.
  useEffect(() => {
    if (!user || !PUBLIC_LINK) return;
    window.history.replaceState({}, '', window.location.pathname);
    goTab('Explore');
    setTimeout(() => push(PUBLIC_LINK.fixture ? 'LiveCentre' : 'Event', { id: PUBLIC_LINK.fixture ?? PUBLIC_LINK.event }), 0);
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!user) return undefined;
    const go = ([name, params]) => { goTab('Schedule'); setTimeout(() => push(name, params), 0); };
    if (Platform.OS === 'web') {
      const q = new URLSearchParams(window.location.search);
      if (q.get('open')) { window.history.replaceState({}, '', window.location.pathname); go(parseTarget(q.get('open'))); }
      const onMsg = (e) => { if (e.data?.type === 'open') go(parseTarget(e.data.target)); };
      navigator.serviceWorker?.addEventListener('message', onMsg);
      return () => navigator.serviceWorker?.removeEventListener('message', onMsg);
    }
    let sub;
    import('expo-notifications').then((N) => {
      N.setNotificationHandler({ handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }) });
      sub = N.addNotificationResponseReceivedListener((r) => go(targetFor(r.notification.request.content.data)));
    }).catch(() => {});
    return () => sub?.remove();
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps
  if (PASSPORT_TOKEN) return <View style={{ flex: 1, backgroundColor: c.bg, paddingTop: ins.top }}><PassportPublic token={PASSPORT_TOKEN} /></View>;
  if (!ready) return <View style={{ flex: 1, backgroundColor: c.bg, justifyContent: 'center', padding: 24 }}><Loading /></View>;
  if (!user && PUBLIC_LINK) return <View style={{ flex: 1, backgroundColor: c.bg, paddingTop: ins.top }}><PublicShell eventId={PUBLIC_LINK.event} fixtureId={PUBLIC_LINK.fixture} renderEvent={(params) => <Event {...params} />} /></View>;
  if (!user) return <View style={{ flex: 1, backgroundColor: c.bg, paddingTop: ins.top }}><BetaBanner /><View style={{ flex: 1 }}><Landing /></View></View>;
  const top = stack[stack.length - 1];
  const Page = top ? PAGES[top.name] : TABS.find((t) => t[0] === tab)[1];
  const prev = stack.length > 1 ? TITLES[stack[stack.length - 2].name] : tab === 'Hub' ? 'More' : tab;
  const pageKey = top ? `${top.name}:${stack.length}:${top.params?.id ?? ''}` : tab;
  return (
    <View style={{ flex: 1, backgroundColor: c.bg, paddingTop: ins.top, paddingLeft: ins.left, paddingRight: ins.right }}>
      <BetaBanner />
      {top ? (HERO_ROUTES.has(top.name) ? null : <NavBar title={TITLES[top.name]} backLabel={prev} onBack={back} />) : <TopBar />}
      {mfa ? <MfaNotice info={mfa} onGo={() => { setMfa(null); goTab('Me'); }} onClose={() => setMfa(null)} /> : null}
      <View style={{ flex: 1 }}>
        <Transition id={pageKey} push={!!top}><Page key={pageKey} {...(top?.params ?? {})} /></Transition>
        {top && HERO_ROUTES.has(top.name) ? <NavOverlay backLabel={prev} onBack={back} /> : null}
        {menu ? <MoreWheel /> : null}
      </View>
      <TabBar />
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar barStyle={dark ? 'light-content' : 'dark-content'} />
      <SessionProvider><BasketProvider><NavProvider><Shell /></NavProvider></BasketProvider></SessionProvider>
    </SafeAreaProvider>
  );
}
