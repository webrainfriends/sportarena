// BookMyShow India — event browsing and ticketing link-out only.
// BookMyShow is a ticketing/entertainment platform, NOT a venue rental platform.
// This connector provides link-out to sport event listings and ticketing pages only.

export const PROVIDER_KEY = 'bookmyshow_in';
export const EVENTS_PAGE = 'https://in.bookmyshow.com/explore/sports';
export const CITY_PAGE = (city) => `https://in.bookmyshow.com/${encodeURIComponent(city?.toLowerCase() ?? '')}/sports`;

const CITY_SLUG_MAP = {
  mumbai: 'mumbai', delhi: 'delhi', bangalore: 'bengaluru', bengaluru: 'bengaluru',
  hyderabad: 'hyderabad', chennai: 'chennai', kolkata: 'kolkata', pune: 'pune',
  ahmedabad: 'ahmedabad', jaipur: 'jaipur', lucknow: 'lucknow', kochi: 'kochi',
};

export function buildLinkoutUrl({ sport_key = '', city = '' } = {}) {
  const slug = CITY_SLUG_MAP[city?.toLowerCase()] ?? city?.toLowerCase();
  if (slug) return CITY_PAGE(slug);
  return EVENTS_PAGE;
}

export const DISCLAIMER =
  'BookMyShow is an event ticketing platform. This connector links to sports event listings ' +
  'and ticketing pages on BookMyShow for India. It does not support venue rental or court booking. ' +
  'GotMyGame provides a convenience link-out only.';

export const CAPABILITY_NOTE =
  'Only event browsing and ticketing link-out is supported via BookMyShow. ' +
  'Venue search, availability, pricing, hold and booking capabilities are not available through this connector. ' +
  'For venue rental in India, use GotMyGame native venues or add a venue manually.';

export async function test() {
  return { ok: true, message: 'BookMyShow link-out ready. Event listings/ticketing only — venue rental is not supported.' };
}
