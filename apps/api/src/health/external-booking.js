// Adapter contract for providers who take bookings on their own site/system. SportArena stores only the minimum:
// the provider's public booking URL (profile), and per appointment the external provider id, reference, URL, sync status and
// timestamps. It never scrapes the other site and never stores credentials for it.
//
// An adapter is { id, label, check(url) -> void|throws, deepLink({ url }) -> string, sync? }.
//  * check    validates a provider-supplied URL for this system (https, expected host).
//  * deepLink the address the person is sent to. No personal data is appended to it.
//  * sync     OPTIONAL: where a system offers an API, an adapter can fetch the booking's status and feed it into
//             reconcileExternal(). None is implemented yet: status reaches SportArena through the provider calling
//             `reconcile_external_booking` (REST/MCP, with an API token) or through the person confirming the booking.
import { badRequest } from '../errors.js';

const https = (raw) => {
  let u;
  try { u = new URL(raw); } catch { throw badRequest('That is not a valid web address'); }
  if (u.protocol !== 'https:') throw badRequest('Booking links must use https');
  if (u.username || u.password) throw badRequest('Booking links must not contain a username or password');
  if (raw.length > 500) throw badRequest('That link is too long');
  return u;
};
const host = (names) => (raw) => {
  const u = https(raw);
  if (!names.some((n) => u.hostname === n || u.hostname.endsWith(`.${n}`))) throw badRequest(`That link must be on ${names.join(' or ')}`);
};

export const ADAPTERS = {
  generic: { id: 'generic', label: "the provider's own site", check: (url) => void https(url), deepLink: ({ url }) => url },
  calendly: { id: 'calendly', label: 'Calendly', check: host(['calendly.com']), deepLink: ({ url }) => url },
  cal_com: { id: 'cal_com', label: 'Cal.com', check: host(['cal.com']), deepLink: ({ url }) => url },
};
export const ADAPTER_IDS = Object.keys(ADAPTERS);
export const adapterFor = (id) => ADAPTERS[id] ?? null;

export const DISCLOSURE = 'You are about to leave SportArena. The booking is made on a site run by the provider, under their terms and privacy policy. SportArena does not see what you enter there. Come back and confirm the booking so it appears in your appointments.';
