// Switching push on for this device: browsers use a service worker + Web Push, phones use Expo push tokens.
import { Platform } from 'react-native';
import { api, storage } from './api';

const KEY = 'pushDevice';
const b64ToBytes = (s) => { const pad = '='.repeat((4 - (s.length % 4)) % 4); const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from([...raw].map((ch) => ch.charCodeAt(0))); };

/** Can this device receive push at all, and if not, why. */
export async function pushSupport() {
  if (Platform.OS === 'web') {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window) || typeof Notification === 'undefined') return { ok: false, reason: "This browser doesn't support push notifications." };
    if (!window.isSecureContext) return { ok: false, reason: 'Browser push needs the secure (https) version of the app.' };
    const cfg = await api.get('/push/config').catch(() => null);
    if (!cfg?.web_public_key) return { ok: false, reason: "Browser push isn't switched on for this server." };
    return { ok: true, webKey: cfg.web_public_key, denied: Notification.permission === 'denied' };
  }
  return { ok: true };
}

export const currentDevice = () => storage.get(KEY);

/** Ask permission, subscribe, and register this device with the server. Returns the device. */
export async function enablePush() {
  const sup = await pushSupport();
  if (!sup.ok) throw new Error(sup.reason);
  let device;
  if (Platform.OS === 'web') {
    if (Notification.permission === 'denied') throw new Error('Notifications are blocked for this site — allow them in your browser settings.');
    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    if ((await Notification.requestPermission()) !== 'granted') throw new Error('Permission was not granted.');
    const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(sup.webKey) }));
    const j = sub.toJSON();
    device = await api.post('/me/push-devices', { provider: 'webpush', platform: 'web', token: j.endpoint, keys: j.keys, label: navigator.userAgent.slice(0, 50) });
  } else {
    const Notifications = await import('expo-notifications');
    const Constants = (await import('expo-constants')).default;
    let perm = await Notifications.getPermissionsAsync();
    if (perm.status !== 'granted') perm = await Notifications.requestPermissionsAsync();
    if (perm.status !== 'granted') throw new Error('Permission was not granted — enable notifications in your phone settings.');
    if (Platform.OS === 'android') await Notifications.setNotificationChannelAsync('default', { name: 'Bookings & updates', importance: Notifications.AndroidImportance.HIGH });
    const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
    if (!projectId) throw new Error('This build has no Expo project id, so the phone cannot get a push token (set extra.eas.projectId and rebuild).');
    const t = await Notifications.getExpoPushTokenAsync({ projectId });
    device = await api.post('/me/push-devices', { provider: 'expo', platform: Platform.OS, token: t.data, label: Platform.OS });
  }
  await storage.set(KEY, device.id);
  return device;
}

/** Stop push on this device (and tell the server). */
export async function disablePush(deviceId) {
  await api.del(`/me/push-devices/${deviceId}`).catch(() => {});
  if (Platform.OS === 'web' && 'serviceWorker' in navigator) {
    const reg = await navigator.serviceWorker.getRegistration('/sw.js');
    const sub = await reg?.pushManager.getSubscription();
    await sub?.unsubscribe().catch(() => {});
  }
  await storage.del(KEY);
}

/** Where a tapped notification should land: [screen, params] or null. */
export function targetFor(data = {}) {
  if (data.spectator && data.fixture_id) return ['LiveCentre', { id: data.fixture_id }]; // an alert for a game you follow
  if (data.screen === 'PlayerFunding') return ['PlayerFunding', data.athlete_id ? { athlete_id: data.athlete_id } : {}]; // an athlete shared their funding with a coach
  if (data.assessment_id) return ['OfficialAssessment', { id: data.assessment_id }]; // an assessment published, corrected, voided or appealed (private development record)
  if (data.observation_id) return ['OfficialsDevelopment', { tab: 'assessor' }];
  if (data.mentorship_id || data.item_id) return ['OfficialsDevelopment', { tab: 'growth' }];
  if (data.cpd_id || data.result_id) return ['OfficialsDevelopment', { tab: 'cpd' }];
  if (data.official_id && data.fixture_id) return ['OfficialsHome', { tab: 'today' }]; // a request, change, release or withdrawal on your officiating crew
  if (data.report_id && data.fixture_id) return ['OfficialMatch', { id: data.fixture_id }]; // an official filed a report on your match
  if (data.proposal_id) return ['ScoringTool', { proposalId: data.proposal_id }]; // a proposed result to review, or the outcome of yours
  if (data.accreditation_id && data.event_id) return ['MyAccreditations', {}]; // a nomination, approval, reissue or revocation of your badge
  if (data.request_id && data.event_id) return ['EventInbox', {}];
  if (data.sponsorship_id) return ['SponsorDeal', { id: data.sponsorship_id }];
  if (data.program_id && (data.task_id || data.application_id)) return ['SponsorProgram', { id: data.program_id }];
  if (data.application_id) return ['FundingOpportunities', {}]; // the applicant's own conversation: opened from My applications
  if (data.cover_id) return ['Cover', {}]; // a cover request, offer, answer, bill to pay or payment made
  if (data.programme_id) return ['Rewards', {}]; // points earned, a referral reward or an adjustment
  if (data.open_game_id) return ['OpenGame', { id: data.open_game_id }]; // a request, approval, waitlist move, change or cancellation of a game
  if (data.reservation_id) return ['Reservation', { id: data.reservation_id }];
  if (data.venue_id && data.date) return ['BookFlow', { venueId: data.venue_id, resourceId: data.resource_id, date: data.date }];
  if (data.venue_id) return ['Venue', { id: data.venue_id }];
  if (data.representative_id) return ['Sponsors', {}]; // an invitation to (or removal from) a sponsor team
  if (data.project_id) return ['TenderNotice', { id: data.project_id }];   // tender notices, receipts, approvals and awards open the tender (the buying team gets a link to its console)
  if (data.organisation_id) return ['Org', { id: data.organisation_id }];   // academy and workspace messages open the organisation (academy tab / My academy)
  return ['Notifications', {}];
}

export function parseTarget(t) {
  const [kind, id, extra] = String(t ?? '').split(':');
  if (kind === 'assessment' && id) return ['OfficialAssessment', { id }];
  if (kind === 'officials-development') return ['OfficialsDevelopment', id ? { tab: id } : {}];
  if (kind === 'federation' && id) return ['FederationHome', extra ? { id, tab: extra } : { id }];
  if (kind === 'open-game' && id) return ['OpenGame', { id }];
  if (kind === 'find-games') return ['FindGames', {}];
  if (kind === 'reservation' && id) return ['Reservation', { id }];
  if (kind === 'cover') return ['Cover', {}];
  if (kind === 'rewards') return ['Rewards', {}];
  if (kind === 'rewards-console' && id) return ['RewardsConsole', { ownerKind: id, ownerId: extra || undefined }];
  if (kind === 'venue' && id) return ['Venue', { id }];
  if (kind === 'sponsorship' && id) return ['SponsorDeal', { id }];
  if (kind === 'organisation' && id) return ['Org', { id }];
  if (kind === 'organisations') return ['Orgs', {}];
  if (kind === 'tender' && id) return ['TenderNotice', { id }];
  if (kind === 'tender-console' && id) return ['TenderConsole', { id }];
  if (kind === 'tender-proposal' && id) return ['TenderProposal', { id }];
  if (kind === 'tender-builder') return ['TenderBuilder', id ? { id } : {}];
  if (kind === 'tenders') return ['TenderHome', {}];
  if (kind === 'tender-zone') return ['TenderZone', {}];
  if (kind === 'billboard') return ['Billboard', {}];
  if (kind === 'event' && id) return ['Event', { id }];
  if (kind === 'fixture' && id) return ['LiveCentre', { id }];
  if (kind === 'following') return ['Following', {}];
  if (kind === 'accreditation') return ['MyAccreditations', {}];
  if (kind === 'event-accreditation' && id) return ['EventCommand', { id, tab: 'accreditation' }];
  if (kind === 'gate' && id) return ['GateScan', { id }];
  if (kind === 'tender-orders') return ['TenderOrders', {}];
  if (kind === 'tender-reports') return ['TenderReports', {}];
  if (kind === 'tender-order' && id) return ['TenderOrder', { id }];
  if (kind === 'supplier-entities') return ['SupplierEntities', {}];
  if (kind === 'sponsors') return ['Sponsors', {}];
  if (kind === 'sponsor-team' && id) return ['SponsorIdentity', { id }];
  if (kind === 'proposal' && id) return ['ScoringTool', { proposalId: id }];
  if (kind === 'tool' && id === 'scoring') return ['ScoringTool', {}];
  if (kind === 'tools') return ['ToolsHome', {}];
  if (kind === 'media') return ['MediaWorkspace', {}];
  if (kind === 'event-media' && id) return ['EventCommand', { id, tab: 'broadcast' }];
  if (kind === 'funding') return ['PlayerFunding', id ? { athlete_id: id } : {}];
  return ['Notifications', {}];
}
