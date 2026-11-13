import { OfflineSync } from './screens/offline-sync';
import { TeamVolunteers } from './screens/team-volunteers';
import { Carpool } from './screens/carpool';
import { GuardianOnboarding, ManagedChildrenList } from './screens/guardian-onboarding';
import { OnboardingHub } from './screens/onboarding-hub';
import { RolePicker } from './screens/role-picker';
import { CoachProfileWizard } from './screens/coach-profile-wizard';
import { PhysioProfileWizard } from './screens/physio-profile-wizard';
import { SponsorWizard } from './screens/sponsor-wizard';
import { JoinTeam, TeamJoinLinks } from './screens/join';
import { StreamHub, StreamViewer } from './screens/stream-hub';
import React, { useEffect } from 'react';
import { Linking, Platform, Pressable, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSession } from './session';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { NavBridge, FocusScope, flushNavigation, navRef, syncActiveTab, useActiveTab, useNav } from './nav';
import { Btn } from './ui';
import { Icon } from './icons';
import { useLayout } from './layout';
import { installWebShell } from './web';
import { api } from './api';
import { parseTarget, targetFor } from './push';
import { targetFromUrl } from './deeplink';
import { AccountButton, InboxButton } from './account';
import { useWorkspace } from './workspace';
import { RoleHome, WorkTab } from './screens/role-home';
import { Migrate } from './screens/migrate';
import { Setup } from './screens/setup';
import { Inbox } from './screens/inbox';
import { BetaBanner } from './beta-banner';
import { Logo } from './logo';
import { VerifierDesk } from './screens/verifier-desk';
import { Wordmark } from './wordmark';
import { c, dark, fam } from './theme';

installWebShell();
import Community from './screens/feed';
import { Explore, Event, Team, Person } from './screens/play';
import { Following, LiveCentre } from './screens/spectate';
import { showPublicEvent, usePublicEvent } from './public-event';
import { TeamManage } from './screens/team-manage';
import { TeamWorkspace } from './screens/team-workspace';
import { TeamChat } from './screens/team-chat';
import { Conversation } from './screens/inbox';
import { TeamDues } from './screens/team-finance';
import { Venue } from './screens/book';
import { Schedule, EventsWorkspace } from './screens/schedule';
import { BookFlow } from './screens/bookflow';
import { Billboard, Insure } from './screens/marketplace';
import { FindGames } from './screens/find-games';
import Network from './screens/network';
import Communities, { Appeal, CommunityDetail } from './screens/communities';
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
import { Cover } from './screens/cover';
import { AcademyPage, SupplierPage } from './screens/directory';
import { AdCampaign } from './screens/ad-campaign';
import { Advertising } from './screens/advertising';
import { Earnings } from './screens/earnings';
import { PlayerContracts } from './screens/player-contracts';
import { Representation } from './screens/representation';
import { Leaderboard, Awards, Health, Sponsors, Supply } from './screens/hub';
import { SponsorDeal } from './screens/sponsor-deal';
import { SponsorOffer } from './screens/sponsor-offer';
import { ApplicationForm } from './screens/sponsor-application';
import { RegistrationHome, RegistrationApply, RegistrationEntry } from './screens/registration';
import { RegistrationManage, RegistrationSetup, RegistrationForm } from './screens/registration-manage';
import { FormBuilder } from './screens/sponsor-form-builder';
import { SponsorPortfolio, PortfolioEntry } from './screens/sponsor-portfolio';
import { PlayerFunding } from './screens/player-funding';
import { SponsorIdentity } from './screens/sponsor-identity';
import { SponsorReports } from './screens/sponsor-reports';
import { SponsorRoi } from './screens/sponsor-roi';
import { SponsorPrograms, SponsorProgram, FundingOpportunities, SponsorCall } from './screens/sponsor-programs';
import { ParaSponsorOutcomes, ParaAthleteStoryConsent, ParaImpactReport } from './screens/para-sponsor-outcomes';
import { SponsorBudgets, SponsorBudget } from './screens/sponsor-budgets';
import { Insurance, InsurerPage } from './screens/insurance';
import { InsurerDesk } from './screens/insurer';
import { BrandedDocuments } from './screens/branded-documents';
import { PartnerConsole, MyPartner } from './screens/partners';
import { VenuePayouts } from './screens/venue-payouts';
import { VenueClaimSubmit, VenueClaimStatus, MyClaims } from './screens/venue-claim';
import VenueImport from './screens/venue-import';
import SettlementRuns, { SettlementStatement } from './screens/settlement-runs';
import { CommercialConsole } from './screens/commercial-console';
import { PlatformSecurity } from './screens/platform-security';
import { SecurityConsole } from './screens/security-console';
import { PlatformBenchmarks } from './screens/platform-benchmarks';
import { PlatformUsers } from './screens/platform-users';
import { AcademyStaffUsage } from './screens/academy-staff-usage';
import { Finance } from './screens/finance';
import { PlansBilling } from './screens/plans-billing';
import { Me } from './screens/me';
import { Support } from './screens/cases';
import { Family } from './screens/family';
import { Orgs, Org } from './screens/org';
import { Federations, FederationHome, FederationRecord, VerifyLicence } from './screens/federation';
import { MediaWorkspace } from './screens/media-workspace';
import { OrgAffiliations, MyLicences } from './screens/federation-club';
import { IntegrityCase, MyIntegrity } from './screens/integrity';
import { ParaClassification } from './screens/para-classification';
import { AccommodationChecklist } from './screens/accommodation-checklist';
import { AccessibleContactPreferences } from './screens/accessible-contact-preferences';
import { AccommodationHistory } from './screens/accommodation-history';
import { ParaPathway, SharedParaPathway } from './screens/para-pathway';
import { PathDetail, ModuleView } from './screens/para-learn';
import { VenueRevenueIntelligence } from './screens/venue-revenue-intelligence';
import { AdaptiveEquipmentExplore, AdaptiveEquipmentHub, AdaptiveLoanFlow, FittingAppointmentFlow, AssetServiceSheet, MyAdaptiveLoans, SupplierAssetCatalogue, AdaptiveEventReadiness } from './screens/adaptive-equipment';
import { DataResidency, DataResidencyConsent, DataResidencyMigration, DataResidencyAdmin } from './screens/data-residency';
import { OfficialsDevelopment } from './screens/officials-development';
import { OfficialsEducation } from './screens/officials-education';
import { OfficialsHome, OfficialMatch } from './screens/officials-home';
import { OpenMatchSlots } from './screens/officials-open-slots';
import { OpenSlotManage } from './screens/open-slot-manage';
import { OfficialsConsole } from './screens/officials-console';
import { OfficialEarnings } from './screens/officials-earnings';
import { OfficialPayoutAccount, AdminOfficialPayoutAccounts } from './screens/official-payout-account';
import { OfficialCrewHub } from './screens/officials-crew';
import { AssignmentBoard } from './screens/officials-assignment-board';
import { OfficialsBulkInvite } from './screens/officials-bulk-invite';
import { OfficialSchedulingRecommendations } from './screens/official-scheduling-recommendations';
import { OrgOfficialsCommand } from './screens/org-officials-command';
import { OfficialAssessment, AssessmentEditor } from './screens/officials-assessment';
import { OfficialVideoReview } from './screens/officials-video-review';
import { OfficialVideoPlayer } from './screens/officials-video-player';
import { OfficialIntlSettings } from './screens/official-intl-settings';
import { OfficialGradeScheme } from './screens/official-grade-scheme';
import { OfficialPortfolio } from './screens/official-portfolio';
import { OfficialProfileWizard, OfficialProfileView } from './screens/official-profile-wizard';
import { OfficialReportWizard, OfficialReportDetail, OfficialReportProvenance } from './screens/official-report-wizard';
import { OfficialTax } from './screens/official-tax';
import { RateCardCatalog } from './screens/rate-card-catalog';
import { RateCardWizard } from './screens/rate-card-wizard';
import { QuoteCalculator } from './screens/quote-calculator';
import { DisciplineCases } from './screens/discipline-cases';
import { OfficialRateAgreements } from './screens/official-rate-agreements';
import { OfficialRateAgreementDetail } from './screens/official-rate-agreement-detail';
import { OfficialRateAgreementWizard } from './screens/official-rate-agreement-wizard';
import { OfficialRateFeePreview } from './screens/official-rate-fee-preview';
import { AcademyFamily } from './screens/academy-portal';
import { InspectorAudits } from './screens/academy-accreditation';
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
import { Competitions } from './screens/competition-home';
import { MatchCentre } from './screens/match-centre';
import { RefereeOfflineSync } from './screens/referee-offline-sync';
import { SessionPad } from './screens/session-pad';
import { ScoreSheet } from './screens/score-sheet';
import { DoctorHome } from './screens/doctor';
import { LegalHome } from './screens/legal';
import { SharedWellness, ChildWellnessSharing } from './screens/wellness-sharing';
import { SeasonReports, ChildSeasonReports, SharedSeasonReports } from './screens/season-reports';
import { CoachHome, CoachAthletes, CoachPlan, CoachCalendar, MyPlans } from './screens/coach';
import { MyDevelopment } from './screens/player-development';
import { PlayerAssistant } from './screens/player-assistant';
import { Copilots } from './screens/copilots';
import { PerformanceStudio, CoachSession, CoachJournal, CoachGoals, CoachCopilot, CoachReports, CoachReport, CoachReportView, CoachMatch, CoachProgrammes, CoachRubrics, CoachGroups, CoachDrills } from './screens/coaching-studio';
import { AccessibleSession } from './screens/coaching-para';
import { CoachProfile, CoachRequest, CoachBoard, CoachDesk, CoachSetup } from './screens/coaching';
import { CoachAdaptive } from './screens/coach-adaptive';
import { CoachRates, CoachCommitments, CoachReviews, CoachAnalytics } from './screens/coach-business';
import { CoachFeedback } from './screens/coach-hub';
import { CoachVenues } from './screens/venue-coaches';
import { CoachClasses } from './screens/coach-classes';
import { ClassStudio } from './screens/class-studio';
import { SessionWorkspace } from './screens/session-workspace';
import { TeamPerformance } from './screens/team-performance';
import { SharedReports, SharedReport } from './screens/shared-reports';
import { Evaluations, Evaluation, MyEvaluations, MyEvaluation } from './screens/evaluations';
import { SupplierWorkspace } from './screens/svc-supplier';
import { ServicesBuyer } from './screens/svc-buyer';
import { MarketplaceHub } from './screens/marketplace-hub';
import { MarketplaceEngagement } from './screens/marketplace-engagement';
import { TrainingVenue, RecurringVenue } from './screens/training-venue';

import { PlayerHome, SportProfile, ImportMatches } from './screens/player';
import { MyPassport, PassportDesk } from './screens/passport';
import { GateScan, MyAccreditations } from './screens/event-accreditation';
import { MyTickets, TicketShop } from './screens/event-tickets';
import { MyCompliance } from './screens/compliance';
import { TripsHome, Trip } from './screens/trips';
import { MyCardsPage, MyPassesPage } from './screens/my-passes';
import { ToolsHome } from './screens/tools';
import { ScoringTool } from './screens/scoring-tool';
import { SportRules } from './screens/sport-rules';
import { CareerTimeline } from './screens/career';
import { HistorySources } from './screens/history-sources';
import { IntegrationHub, IntegrationRequests } from './screens/integration-hub';
import { SportsGraph, Athlete360, Organisation360 } from './screens/graph';
import { Analytics } from './screens/analytics';
import { RecruiterHome, RecruiterAccess } from './screens/recruiter';
import { MoreWheel } from './screens/more-wheel';
import { VideoAnalysisScreen } from './screens/video-analysis';
import { ConnectedDevicesScreen } from './screens/connected-devices';
import { Glass } from './glass';
import { tapped } from './haptics';
import { t } from './i18n';

// https hosts that open this app as a universal / app link (set EXPO_PUBLIC_APP_HOSTS, comma separated); the sportarena:// scheme always works
const APP_HOSTS = (process.env.EXPO_PUBLIC_APP_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean);

import { PUBLIC_LINK } from './app-links';

// Tabs: the five on the bar are Home, Calendar (Schedule), More (the centre swivel, not a page), Workbench (route Work) and Me; Inbox sits in the top bar; Explore and Player stay reachable by name (goTab) from Home, Work and the swivel.
// Work hosts the active role's own workspace screen, so it needs the page registry below (resolved when it renders).
const WorkPage = () => <WorkTab pages={PAGES} />;
const TABS = [['Home', RoleHome], ['Explore', Explore], ['Schedule', Schedule], ['Player', PlayerHome], ['Work', WorkPage], ['Inbox', Inbox], ['Me', Me]];
const PAGES = { RefereeOfflineSync, OfficialEarnings, AssignmentBoard, OfficialsBulkInvite, OfficialSchedulingRecommendations, OrgOfficialsCommand, OfficialCrewHub, OpenMatchSlots, OpenSlotManage, VenueRevenueIntelligence, ParaLearnPath: PathDetail, ParaLearnModule: ModuleView, VideoAnalysis: VideoAnalysisScreen, ConnectedDevices: ConnectedDevicesScreen, AccessibleSession, VerifierDesk, ParaClassification, AccommodationChecklist, AccessibleContactPreferences, AccommodationHistory, ParaPathway, SharedParaPathway, ClassStudio, SessionWorkspace, TeamPerformance, SharedReports, SharedReport, Evaluations, Evaluation, MyEvaluations, MyEvaluation, Communities, CommunityDetail, Appeal, Network, IntegrationHub, IntegrationRequests, EventsWorkspace, Finance, Analytics, Community, Inbox, Marketplace: MarketplaceHub, MarketplaceEngagement, MyCompliance, SportsGraph, Athlete360, Organisation360, Representation, IntegrityCase, MyIntegrity, AcademyPage, SupplierPage, Advertising, AdCampaign, Trips: TripsHome, Trip, Cover, OfficialsConsole, OfficialsHome, OfficialMatch, Rewards, RewardsConsole, MyPasses: MyPassesPage, MyCards: MyCardsPage, CommercialConsole, FindGames, OpenGame, Following, LiveCentre, GateScan, MyAccreditations, OfficialsDevelopment, OfficialsEducation, OfficialAssessment, AssessmentEditor, OfficialProfileWizard, OfficialProfileView, OfficialReportWizard, OfficialReportDetail, OfficialReportProvenance, DisciplineCases, OfficialPayoutAccount, AdminOfficialPayoutAccounts, OfficialTax, RateCardCatalog, RateCardWizard, QuoteCalculator, MediaWorkspace, Federations, FederationHome, FederationRecord, VerifyLicence, OrgAffiliations, MyLicences, SupplierWorkspace, VenueWorkspace, VenueClaimSubmit, VenueClaimStatus, MyClaims, VenueImport, SettlementRuns, SettlementStatement, ServicesBuyer, SeasonReports, ChildSeasonReports, SharedSeasonReports, PlayerFunding, SharedWellness, ChildWellnessSharing, PlayerContracts, OfflineSync, PathwayPlan, SharedPathway, SponsorIdentity, OpportunityMatches, ToolsHome, ScoringTool, SportRules, MyApplications, RecruitmentApplication, RecruitmentPipeline, Trials, RecruiterHome, RecruiterAccess, AcademySession, AcademyAgenda, CareerTimeline, SponsorReports, SponsorRoi, SponsorBudgets, SponsorBudget, BrandedDocuments, Billboard, Shop, ShopProduct, ShopCart, ShopOrders, Insure, Pathways, Programme, Institution, Enquiry, Passport: MyPassport, PassportDesk, Event, PartnerConsole, MyPartner, Team, TeamManage, TeamWorkspace, TeamChat, TeamDues, Person, Venue, Wallet, Earnings, BookFlow, Invoice, Basket, Reservation, Compare, Notifications, Manage, OwnerSummary, Leaderboard, Awards, Health, DoctorHome, Legal: LegalHome, Insurance, InsurerPage, InsurerDesk, Sponsors, SponsorDeal, SponsorOffer, SponsorPortfolio, PortfolioEntry, SponsorPrograms, SponsorProgram, FundingOpportunities, SponsorCall, ApplicationForm, FormBuilder, Supply, SportProfile, ImportMatches, Support, Family, CoachHome, CoachAthletes, CoachPlan, CoachCalendar, MyPlans, PerformanceStudio, CoachSession, CoachJournal, CoachGoals, MyDevelopment, PlayerAssistant, CoachCopilot, CoachReports, CoachReport, CoachReportView, CoachMatch, CoachProgrammes, CoachRubrics, Orgs, Org, AcademyFamily, AcademyAudits: InspectorAudits, Games, RaceDesk, RaceLive, EventInbox, Openings, CoachProfile, CoachRequest, CoachBoard, CoachDesk, CoachSetup, CoachAdaptive, CoachRates, CoachCommitments, CoachReviews, CoachFeedback, CoachAnalytics, TrainingVenue, RecurringVenue, EventCommand, MatchCentre, SessionPad, ScoreSheet, TenderNotice, SupplierEntities, TenderProposal, TenderProposals, TenderBuilder, TenderConsole, TenderHome, TenderOrders, TenderOrder, TenderReports, TenderZone: TenderZonePage, RegistrationHome, RegistrationApply, RegistrationEntry, RegistrationManage, RegistrationSetup, RegistrationForm, PlatformSecurity, SecurityConsole, PlatformBenchmarks, CoachGroups, CoachDrills, HistorySources, Migrate, Setup, Conversation, Competitions, VenuePayouts, CoachClasses, MyTickets, Tickets: TicketShop, Copilots, TeamVolunteers, Carpool, GuardianOnboarding, ManagedChildrenList, JoinTeam, TeamJoinLinks, StreamHub, StreamViewer, ParaSponsorOutcomes, ParaAthleteStoryConsent, ParaImpactReport, AdaptiveEquipmentExplore, AdaptiveEquipmentHub, AdaptiveLoanFlow, FittingAppointmentFlow, AssetServiceSheet, MyAdaptiveLoans, SupplierAssetCatalogue, AdaptiveEventReadiness, DataResidency, DataResidencyConsent, DataResidencyMigration, DataResidencyAdmin, PlatformUsers, AcademyStaffUsage, OfficialVideoReview, OfficialVideoPlayer, OfficialIntlSettings, OfficialGradeScheme, OfficialPortfolio, OnboardingHub, RolePicker, CoachProfileWizard, PhysioProfileWizard, SponsorWizard };
// Screen titles follow the chosen language: one key per route (nav.title.ROUTE_NAME), read once at load like the rest of the language.
const TITLE_ROUTES = ['RefereeOfflineSync', 'OfficialEarnings', 'AssignmentBoard', 'OfficialsBulkInvite', 'OfficialSchedulingRecommendations', 'OpenMatchSlots', 'OpenSlotManage', 'OrgOfficialsCommand', 'OfficialCrewHub', 'VenueRevenueIntelligence', 'ParaLearnPath', 'ParaLearnModule', 'VideoAnalysis', 'ConnectedDevices', 'AccessibleSession', 'VerifierDesk', 'ParaClassification', 'AccommodationChecklist', 'AccessibleContactPreferences', 'AccommodationHistory', 'ParaPathway', 'SharedParaPathway', 'ClassStudio', 'SessionWorkspace', 'TeamPerformance', 'SharedReports', 'SharedReport', 'Evaluations', 'Evaluation', 'MyEvaluations', 'MyEvaluation', 'Communities', 'CommunityDetail', 'Appeal', 'Network', 'IntegrationHub', 'IntegrationRequests', 'EventsWorkspace', 'Finance', 'Analytics', 'Community', 'Inbox', 'Marketplace', 'MarketplaceEngagement', 'MyCompliance', 'SportsGraph', 'Athlete360', 'Organisation360', 'Representation', 'IntegrityCase', 'MyIntegrity', 'AcademyPage', 'SupplierPage', 'Advertising', 'AdCampaign', 'Trips', 'Trip', 'Cover', 'OfficialsConsole', 'OfficialsHome', 'OfficialMatch', 'Rewards', 'RewardsConsole', 'MyPasses', 'MyCards', 'CommercialConsole', 'FindGames', 'OpenGame', 'Following', 'LiveCentre', 'GateScan', 'MyAccreditations', 'OfficialsDevelopment', 'OfficialsEducation', 'OfficialAssessment', 'AssessmentEditor', 'OfficialProfileWizard', 'OfficialProfileView', 'OfficialReportWizard', 'OfficialReportDetail', 'OfficialReportProvenance', 'DisciplineCases', 'OfficialPayoutAccount', 'AdminOfficialPayoutAccounts', 'OfficialTax', 'RateCardCatalog', 'RateCardWizard', 'QuoteCalculator', 'MediaWorkspace', 'Federations', 'FederationHome', 'FederationRecord', 'VerifyLicence', 'OrgAffiliations', 'MyLicences', 'VenueWorkspace', 'VenueClaimSubmit', 'VenueClaimStatus', 'MyClaims', 'VenueImport', 'SettlementRuns', 'SettlementStatement', 'SupplierWorkspace', 'ServicesBuyer', 'SeasonReports', 'ChildSeasonReports', 'SharedSeasonReports', 'PlayerFunding', 'SharedWellness', 'ChildWellnessSharing', 'PlayerContracts', 'OfflineSync', 'PathwayPlan', 'SharedPathway', 'SponsorIdentity', 'OpportunityMatches', 'PassportDesk', 'ToolsHome', 'ScoringTool', 'SportRules', 'MyApplications', 'RecruitmentApplication', 'RecruitmentPipeline', 'Trials', 'RecruiterHome', 'RecruiterAccess', 'AcademySession', 'AcademyAgenda', 'CareerTimeline', 'SponsorReports', 'SponsorRoi', 'SponsorBudgets', 'SponsorBudget', 'BrandedDocuments', 'Billboard', 'Shop', 'ShopProduct', 'ShopCart', 'ShopOrders', 'Insure', 'Pathways', 'Programme', 'Institution', 'Enquiry', 'Passport', 'Event', 'PartnerConsole', 'MyPartner', 'Team', 'TeamManage', 'TeamWorkspace', 'TeamChat', 'TeamDues', 'Person', 'Venue', 'Wallet', 'Earnings', 'BookFlow', 'Invoice', 'Basket', 'Reservation', 'Compare', 'Notifications', 'Manage', 'OwnerSummary', 'Leaderboard', 'Awards', 'Health', 'DoctorHome', 'Legal', 'Insurance', 'InsurerPage', 'InsurerDesk', 'Sponsors', 'SponsorDeal', 'SponsorOffer', 'SponsorPortfolio', 'PortfolioEntry', 'SponsorPrograms', 'SponsorProgram', 'FundingOpportunities', 'SponsorCall', 'ApplicationForm', 'FormBuilder', 'Supply', 'SportProfile', 'ImportMatches', 'Support', 'Family', 'CoachHome', 'CoachAthletes', 'CoachPlan', 'CoachCalendar', 'PerformanceStudio', 'CoachSession', 'CoachJournal', 'CoachGoals', 'MyDevelopment', 'PlayerAssistant', 'CoachCopilot', 'CoachReports', 'CoachReport', 'CoachReportView', 'CoachMatch', 'CoachProgrammes', 'CoachRubrics', 'MyPlans', 'Orgs', 'Org', 'AcademyFamily', 'AcademyAudits', 'Games', 'RaceDesk', 'RaceLive', 'EventInbox', 'Openings', 'CoachProfile', 'CoachRequest', 'CoachBoard', 'CoachDesk', 'CoachSetup', 'CoachAdaptive', 'CoachRates', 'CoachCommitments', 'CoachReviews', 'CoachFeedback', 'CoachAnalytics', 'TrainingVenue', 'RecurringVenue', 'EventCommand', 'MatchCentre', 'SessionPad', 'ScoreSheet', 'TenderNotice', 'SupplierEntities', 'TenderProposal', 'TenderProposals', 'TenderBuilder', 'TenderConsole', 'TenderHome', 'TenderOrders', 'TenderOrder', 'TenderReports', 'TenderZone', 'RegistrationHome', 'RegistrationApply', 'RegistrationEntry', 'RegistrationManage', 'RegistrationSetup', 'RegistrationForm', 'PlatformSecurity', 'SecurityConsole', 'PlatformBenchmarks', 'CoachGroups', 'CoachDrills', 'HistorySources', 'Migrate', 'Setup', 'Conversation', 'Competitions', 'VenuePayouts', 'CoachClasses', 'MyTickets', 'Tickets', 'Copilots', 'TeamVolunteers', 'Carpool', 'GuardianOnboarding', 'ManagedChildrenList', 'JoinTeam', 'TeamJoinLinks', 'StreamHub', 'StreamViewer', 'ParaSponsorOutcomes', 'ParaAthleteStoryConsent', 'ParaImpactReport', 'AdaptiveEquipmentExplore', 'AdaptiveEquipmentHub', 'AdaptiveLoanFlow', 'FittingAppointmentFlow', 'AssetServiceSheet', 'MyAdaptiveLoans', 'SupplierAssetCatalogue', 'AdaptiveEventReadiness', 'DataResidency', 'DataResidencyConsent', 'DataResidencyMigration', 'DataResidencyAdmin', 'PlatformUsers', 'AcademyStaffUsage', 'OfficialIntlSettings', 'OfficialGradeScheme', 'OfficialPortfolio', 'OnboardingHub', 'RolePicker', 'CoachProfileWizard', 'PhysioProfileWizard', 'SponsorWizard'];
const TITLES = Object.fromEntries(TITLE_ROUTES.map((n) => [n, t(`nav.title.${n}`)]));
// The bar follows what a person does, not the platform's modules: Home (today and what needs me), Calendar, More (the raised centre button: the swivel of every
// module), Workbench (route Work: the active role's queue, fast actions and tools in one page) and Me (profile, roles, security). The Inbox is the button at the top right.
const TAB_LABEL = { Home: t('nav.home'), Schedule: t('nav.tab.Calendar'), Me: t('nav.tab.Profile'), Hub: t('nav.tab.More'), Work: t('nav.tab.Workbench') };
const BAR = ['Home', 'Schedule', 'Hub', 'Work', 'Me'];

/** Bottom tab bar. Phone: edge-to-edge bar. Tablet / large screens: a floating pill, like an iPad app. */
function TabBar() {
  const { goTab, menu, toggleMenu } = useNav();
  const tab = useActiveTab();
  const ins = useSafeAreaInsets();
  const { tablet, width } = useLayout();
  const ws = useWorkspace();
  const badge = { Work: ws?.data?.work?.length ?? 0 };
  const items = BAR.map((name) => {
    const centre = name === 'Hub';
    const on = centre ? menu : !menu && tab === name;
    const label = TAB_LABEL[name] ?? name;
    const n = badge[name] ?? 0;
    return (
      <Pressable key={name} accessibilityRole="tab" accessibilityLabel={centre && menu ? 'Close More' : n ? `${label}, ${n} waiting` : label} accessibilityState={{ selected: on, expanded: centre ? menu : undefined }} onPress={tapped(() => (centre ? toggleMenu() : goTab(name, name === 'Schedule' ? { section: 'agenda' } : {})))} style={({ pressed }) => ({ flex: 1, alignItems: 'center', justifyContent: 'flex-end', minHeight: 56, opacity: pressed ? 0.6 : 1 })}>
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
            {n ? <View accessibilityElementsHidden importantForAccessibility="no" style={{ position: 'absolute', top: 0, right: tablet ? 8 : 4, minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 4, backgroundColor: c.red, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: '#fff', fontSize: 10.5, fontWeight: '800' }}>{n > 99 ? '99+' : n}</Text></View> : null}
          </Glass>
        )}
        <Text numberOfLines={1} style={[fam, { fontSize: tablet ? 12 : 10.5, fontWeight: on ? '700' : '600', color: on ? c.pink : c.mute, marginTop: 2, marginBottom: 2 }]}>{label}</Text>
      </Pressable>
    );
  });
  return (
    <View pointerEvents="box-none" style={{ position: 'absolute', left: 0, right: 0, bottom: Math.max(ins.bottom, 12), alignItems: 'center' }}>
      <View accessibilityRole="tablist" style={{ flexDirection: 'row', alignItems: 'flex-end', width: Math.min(620, width - 24), paddingHorizontal: 8, paddingVertical: 6 }}>
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
        <TopRight />
      </View>
    </View>
  );
}

/** The Inbox and the account button (appearance, log out), always together at the top right. */
function TopRight() {
  return <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}><InboxButton /><AccountButton /></View>;
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
        <View style={{ marginLeft: 'auto' }}><TopRight /></View>
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
          <Wordmark width={112} />
        </View>
        <TopRight />
      </View>
    </View>
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


// ---------------------------------------------------------------- the native stack and tabs
// Pushed pages sit on a native stack (swipe back on iOS, the platform's own transition, the Android back button) and the tab roots on a tab
// navigator that keeps each tab alive, so scroll position and typed text survive a switch. The look is unchanged: our own back bar and top bar are
// drawn inside each screen, and the floating tab bar sits above both (TabBar).
const Stack = createNativeStackNavigator();
const Tab = createBottomTabNavigator();
const NAV_THEME = { ...DefaultTheme, colors: { ...(DefaultTheme?.colors ?? {}), background: c.bg, card: c.bg, border: c.line, text: c.ink, primary: c.pink } };
const tabOf = (r) => (r?.state ? r.state.routes[r.state.index]?.name : r?.params?.screen) ?? 'Home';

/** A pushed page: the back bar on top and the page below it. */
function PushedPage({ name, Page, route, navigation }) {
  const { back } = useNav();
  const routes = navigation.getState().routes;
  const before = routes[routes.findIndex((r) => r.key === route.key) - 1];
  const prev = before?.name === 'Tabs' ? TAB_LABEL[tabOf(before)] ?? tabOf(before) : TITLES[before?.name] ?? '';
  const hero = HERO_ROUTES.has(name);
  const Body = Page;
  return (
    <FocusScope navigation={navigation}>
      <View style={{ flex: 1, backgroundColor: c.bg }}>
        {hero ? null : <NavBar title={TITLES[name]} backLabel={prev} onBack={back} />}
        <View style={{ flex: 1 }}>
          <Body {...(route.params ?? {})} />
          {hero ? <NavOverlay backLabel={prev} onBack={back} /> : null}
        </View>
      </View>
    </FocusScope>
  );
}
const PUSHED = Object.entries(PAGES).map(([name, Page]) => [name, (props) => <PushedPage name={name} Page={Page} {...props} />]);

/** A tab root: the top bar (logo, Inbox, account) and the tab's screen. goTab('Schedule', { section }) arrives as the screen's props. */
function TabPage({ Page, route, navigation }) {
  const Body = Page;
  return (
    <FocusScope navigation={navigation}>
      <View style={{ flex: 1, backgroundColor: c.bg }}>
        <TopBar />
        <Body {...(route.params ?? {})} />
      </View>
    </FocusScope>
  );
}
const TAB_SCREENS = TABS.map(([name, Page]) => [name, (props) => <TabPage Page={Page} {...props} />]);

function Tabs() {
  return (
    <Tab.Navigator initialRouteName="Home" backBehavior="none" tabBar={() => null} screenOptions={{ headerShown: false, lazy: true, sceneStyle: { backgroundColor: c.bg } }}>
      {TAB_SCREENS.map(([name, component]) => <Tab.Screen key={name} name={name} component={component} />)}
    </Tab.Navigator>
  );
}

/** Everything between the banner and the tab bar: the notice, the stack and the More wheel. */
function Chrome({ mfa, onMfaClose }) {
  const { menu, goTab } = useNav();
  return (
    <View style={{ flex: 1 }}>
      {mfa ? <MfaNotice info={mfa} onGo={() => { onMfaClose(); goTab('Me'); }} onClose={onMfaClose} /> : null}
      <View style={{ flex: 1 }}>
        <Stack.Navigator initialRouteName="Tabs" screenOptions={{ headerShown: false, contentStyle: { backgroundColor: c.bg }, fullScreenGestureEnabled: true }}>
          <Stack.Screen name="Tabs" component={Tabs} options={{ gestureEnabled: false }} />
          {PUSHED.map(([name, component]) => <Stack.Screen key={name} name={name} component={component} />)}
        </Stack.Navigator>
        {menu ? <MoreWheel /> : null}
      </View>
    </View>
  );
}

/** What happens when a link, a tapped notification or a payment return opens the app. It lives inside the navigators, so push / goTab reach them. */
function NavEffects() {
  const { user, toast } = useSession();
  const { goTab, push } = useNav();
  const nativeEvent = usePublicEvent();
  // Back from Stripe / PayPal / Razorpay checkout: the web gets ?payment=<id>&result=success|cancel, the phone apps get sportarena://payment?... (see /api/v1/pay/return).
  // The address is only a hint: the server is asked whether the payment went through, and the screen is chosen from its answer.
  const finishPayment = (id, result) => {
    goTab('Schedule');
    if (result !== 'success') return toast('Payment cancelled — nothing was charged');
    api.post(`/payments/${id}/confirm`).then(async (r) => {
      toast(r.status === 'paid' ? 'Payment received ✓' : 'Payment is still processing — check back shortly');
      if (r.purpose_type === 'shop_checkout' || r.purpose_type === 'shop_order') push('ShopOrders');
      if (r.purpose_type === 'sponsorship_payment' && r.sponsorship_id) { goTab('Schedule'); push('SponsorDeal', { id: r.sponsorship_id }); }
      if (r.purpose_type === 'venue_invoice') { const inv = await api.get(`/invoices/${r.purpose_id}`).catch(() => null); if (inv) { goTab('Schedule'); push('Reservation', { id: inv.reservation_id }); } }
    }).catch((e) => toast(e.message));
  };
  useEffect(() => {
    if (Platform.OS !== 'web' || !user) return;
    const q = new URLSearchParams(window.location.search);
    const id = q.get('payment');
    if (!id) return;
    window.history.replaceState({}, '', window.location.pathname);
    finishPayment(id, q.get('result'));
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps
  // A tapped push notification opens the right screen: from the web service worker (?open= or a message) or from the phone.
  // Opening a shared link while signed in: straight to the event or the live game.
  // A public event opened from the landing page on a phone: once they sign in, carry on to the same event inside the app.
  useEffect(() => {
    if (!user || !nativeEvent) return;
    const id = nativeEvent;
    showPublicEvent(null);
    goTab('Explore');
    setTimeout(() => push('Event', { id }), 0);
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!user || !PUBLIC_LINK || PUBLIC_LINK.clip) return;
    window.history.replaceState({}, '', window.location.pathname);
    goTab('Explore');
    setTimeout(() => push(PUBLIC_LINK.fixture ? 'LiveCentre' : 'Event', { id: PUBLIC_LINK.fixture ?? PUBLIC_LINK.event }), 0);
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!user) return undefined;
    const go = ([name, params]) => { goTab('Home'); setTimeout(() => push(name, params), 0); };
    if (Platform.OS === 'web') {
      const q = new URLSearchParams(window.location.search);
      if (q.get('open')) { window.history.replaceState({}, '', window.location.pathname); go(parseTarget(q.get('open'))); }
      const onMsg = (e) => { if (e.data?.type === 'open') go(parseTarget(e.data.target)); };
      navigator.serviceWorker?.addEventListener('message', onMsg);
      return () => navigator.serviceWorker?.removeEventListener('message', onMsg);
    }
    // links that open the app (sportarena://gate/<event>, universal links): same targets as a tapped push
    const open = (url) => {
      const t = targetFromUrl(url, APP_HOSTS);
      const pay = /^payment:([0-9a-f-]{36}):(success|cancel)$/i.exec(t ?? '');
      if (pay) finishPayment(pay[1], pay[2]); else if (t) go(parseTarget(t));
    };
    Linking.getInitialURL().then(open).catch(() => {});
    const link = Linking.addEventListener('url', (e) => open(e.url));
    let sub;
    import('expo-notifications').then((N) => {
      N.setNotificationHandler({ handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }) });
      sub = N.addNotificationResponseReceivedListener((r) => go(targetFor(r.notification.request.content.data)));
    }).catch(() => {});
    return () => { sub?.remove(); link.remove(); };
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

/** The signed-in app (navigators, every screen). Loaded on demand from App.js so the landing page does not download it. */
export default function AuthedApp({ mfa, onMfaClose }) {
  const ins = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, backgroundColor: c.bg, paddingTop: ins.top, paddingLeft: ins.left, paddingRight: ins.right }}>
      <BetaBanner />
      <NavigationContainer ref={navRef} theme={NAV_THEME} documentTitle={{ enabled: false }} onReady={() => { flushNavigation(); syncActiveTab(); }} onStateChange={syncActiveTab}>
        <NavBridge>
          <NavEffects />
          <Chrome mfa={mfa} onMfaClose={onMfaClose} />
          <TabBar />
        </NavBridge>
      </NavigationContainer>
    </View>
  );
}
