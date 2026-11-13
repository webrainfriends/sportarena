// ActiveSG Singapore venue booking — redirect/link-out only.
// No scraping, no automated booking. Singpass required for actual booking on ActiveSG.
// Formal API access subject to Sport Singapore partnership agreement.

export const PROVIDER_KEY = 'activesg_sg';
export const BOOKING_PAGE = 'https://book.myactivesg.com/facilities';
export const SEARCH_PAGE = 'https://book.myactivesg.com/facilities/search';

const SPORT_MAP = {
  badminton: 'badminton', tennis: 'tennis', squash: 'squash', basketball: 'basketball',
  football: 'football', soccer: 'football', futsal: 'futsal', volleyball: 'volleyball',
  swimming: 'swimming', gymnastics: 'gymnastics', table_tennis: 'table-tennis',
  hockey: 'hockey', netball: 'netball', cricket: 'cricket',
};

export function buildLinkoutUrl({ venue_name = '', sport_key = '', city = '' } = {}) {
  const params = new URLSearchParams();
  const mapped = SPORT_MAP[sport_key?.toLowerCase()] ?? sport_key;
  if (mapped) params.set('sport', mapped);
  if (city) params.set('region', city);
  if (venue_name) params.set('venue', venue_name);
  const qs = params.toString();
  return qs ? `${SEARCH_PAGE}?${qs}` : BOOKING_PAGE;
}

export const DISCLAIMER =
  'ActiveSG venues are managed by Sport Singapore. Booking requires a Singpass account. ' +
  'Availability, pricing and slot allocation are governed by ActiveSG and are subject to ballot where demand is high. ' +
  'GotMyGame provides a convenience link-out only and does not guarantee availability or pricing shown by ActiveSG.';

export async function test() {
  return { ok: true, message: 'ActiveSG link-out ready. No live API — booking is handled on the ActiveSG platform.' };
}
