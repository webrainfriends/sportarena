// Advertising policy (#524): the placement catalogue, which categories may buy reach, and what a campaign may be targeted on.
// This file is the written form of the rules the engine and the review desk enforce. Nothing here reads or changes an organic ranking.

/**
 * placement → organic source → advertiser eligibility → measurement source (the assessment the issue asks for, as data).
 * `surface` is where the app renders it; `organic` is the list or page that stays untouched beside it.
 */
export const PLACEMENTS = {
  featured_venue: { label: 'Featured venue', surface: 'Find a court (venue search)', organic: 'GET /venues — ordered by the visitor’s own sort, unchanged', entity: 'venue', disclosure: 'promoted', eligibility: 'You manage the venue', measurement: 'served impressions and call-to-action follows' },
  featured_coach: { label: 'Featured coach or professional', surface: 'Coach search', organic: 'GET /coaches — rating / price order, unchanged', entity: 'coach', disclosure: 'promoted', eligibility: 'It is you, or a coach in your organisation', measurement: 'served impressions and call-to-action follows' },
  featured_academy: { label: 'Featured academy', surface: 'Explore → Academies', organic: 'GET /academies — by name, unchanged', entity: 'academy', disclosure: 'promoted', eligibility: 'You run the academy organisation', measurement: 'served impressions and call-to-action follows' },
  featured_event: { label: 'Featured public event', surface: 'Event discovery', organic: 'GET /events/search — unchanged', entity: 'event', disclosure: 'promoted', eligibility: 'You organise a public, adult event that is open', measurement: 'served impressions and call-to-action follows' },
  promoted_supplier: { label: 'Promoted supplier listing', surface: 'Explore → Suppliers', organic: 'GET /suppliers — by name, unchanged', entity: 'supplier', disclosure: 'promoted', eligibility: 'It is your active supplier profile', measurement: 'served impressions and call-to-action follows' },
  sponsored_post: { label: 'Sponsored community post or challenge', surface: 'Community feed', organic: 'GET /market/posts — chronological, unchanged', entity: null, disclosure: 'sponsored', eligibility: 'Any approved advertiser', measurement: 'served impressions and call-to-action follows' },
  event_display: { label: 'Event or tournament display', surface: 'Public event page', organic: 'GET /public/events/:id — the event’s own content, unchanged', entity: null, disclosure: 'sponsored', rights: 'event', eligibility: 'Any approved advertiser; the event organiser must allow ads on the page', measurement: 'served impressions and call-to-action follows' },
  scorecard_leaderboard: { label: 'Scorecard or leaderboard placement', surface: 'Live centre and table', organic: 'Scores, standings and awards — never reordered', entity: null, disclosure: 'sponsored', rights: 'event', eligibility: 'Any approved advertiser; the event organiser must allow ads on the page', measurement: 'served impressions and call-to-action follows' },
  search_sponsored: { label: 'Sponsored search slot', surface: 'Above search results (venues, events, coaches, suppliers)', organic: 'The search results below it — same order with or without the slot', entity: null, disclosure: 'sponsored', keywords: true, eligibility: 'Any approved advertiser; matched on what the visitor searched', measurement: 'served impressions and call-to-action follows' },
};
export const PLACEMENT_CODES = Object.keys(PLACEMENTS);

/** Landing entities and the placements that need one. */
export const ENTITY_TYPES = ['venue', 'coach', 'academy', 'event', 'supplier'];
export const CTAS = { learn_more: 'Learn more', book_now: 'Book now', register: 'Register', shop_now: 'Shop now', view: 'View', get_directions: 'Get directions' };

/**
 * Who may buy reach. `allowed` categories are open; `prohibited` ones can never be approved or served — the review desk cannot override them,
 * the API refuses them at creation, and the serve path checks again. Regulated or unsafe products stay out whatever the budget.
 */
export const CATEGORIES = {
  venues_facilities: { label: 'Venues and facilities', allowed: true },
  coaching_training: { label: 'Coaching and training', allowed: true },
  academies_education: { label: 'Academies and education', allowed: true },
  events_tickets: { label: 'Events and tickets', allowed: true },
  equipment_apparel: { label: 'Sports equipment and apparel', allowed: true },
  food_beverage: { label: 'Food and non-alcoholic drinks', allowed: true },
  travel_experiences: { label: 'Travel and experiences', allowed: true },
  media_content: { label: 'Media and content', allowed: true },
  technology_services: { label: 'Technology and services', allowed: true },
  other_sports_related: { label: 'Other sports-related', allowed: true },
  alcohol: { label: 'Alcohol', allowed: false },
  tobacco_vaping: { label: 'Tobacco and vaping', allowed: false },
  gambling_betting: { label: 'Gambling and betting', allowed: false },
  weapons: { label: 'Weapons', allowed: false },
  adult_content: { label: 'Adult content', allowed: false },
  performance_enhancing: { label: 'Performance-enhancing or banned substances', allowed: false },
  supplements_health_claims: { label: 'Supplements and health claims', allowed: false },
  prescription_medicines: { label: 'Prescription or regulated medicines', allowed: false },
  financial_speculation: { label: 'Crypto, trading and speculative finance', allowed: false },
  high_cost_credit: { label: 'High-cost credit and payday loans', allowed: false },
  political_advocacy: { label: 'Political advocacy', allowed: false },
};
export const ALLOWED_CATEGORIES = Object.keys(CATEGORIES).filter((k) => CATEGORIES[k].allowed);
export const PROHIBITED_CATEGORIES = Object.keys(CATEGORIES).filter((k) => !CATEGORIES[k].allowed);
export const isCategoryAllowed = (code) => CATEGORIES[code]?.allowed === true;

/**
 * What a campaign may be targeted on. Everything else is refused by name, not just ignored, so a request that asks for it fails loudly.
 * The serve path reads exactly these inputs and nothing about the person beyond a keyed hash for the frequency cap.
 */
export const TARGETING_ALLOWED = ['sports', 'countries', 'cities', 'keywords', 'audience (everyone or followers of the advertiser)', 'frequency_per_day', 'placement context'];
export const TARGETING_FORBIDDEN = ['health or clinical data', 'legal matters', 'insurance claims', 'inferred sensitive demographics', 'private youth data', 'private communications', 'precise location'];
export const FORBIDDEN_TARGETING_KEYS = ['health', 'clinical', 'injury', 'medical', 'legal', 'insurance', 'claim', 'ethnicity', 'religion', 'gender', 'sexuality', 'age', 'child', 'youth_profile', 'lat', 'lng', 'latitude', 'longitude', 'messages', 'chat'];

export const CLAIM_TYPES = { price: 'Prices or discounts', results: 'Results or rankings', health: 'Health or fitness outcomes', endorsement: 'Endorsements or reviews', availability: 'Availability or limited offers', none: 'No factual claims' };

/** Measurement definitions published with every report. Nothing outside these is measured, and nothing is estimated. */
export const METRIC_DEFINITIONS = {
  impressions: 'The platform served the creative in response to a request for the placement. Viewability and on-screen time are not measured.',
  clicks: 'A visitor followed the call to action of an impression the platform served. One click counts per impression; repeats are not counted.',
  ctr: 'Clicks divided by billable impressions. Shown only when there is at least one impression.',
  spend: 'What the campaign was charged: the flat fee, or the price per thousand impressions or per click, applied to billable events only.',
  invalid: 'Events not charged: repeats within the same short window, over the person’s daily frequency cap, or after the budget ran out.',
  unique_reach: 'Not measured. The platform does not track people across visits, so no reach figure is given.',
  conversions: 'Not measured. Conversions need an explicit integration that supplies them; until one exists none are shown or inferred.',
};

export const REVIEW_REASONS = ['prohibited_category', 'misleading_claim', 'unsafe_or_harmful', 'youth_safety', 'landing_page', 'intellectual_property', 'targeting', 'other'];
export const REPORT_REASONS = ['misleading', 'offensive', 'irrelevant', 'unsafe', 'not_for_children', 'other'];

/** Landing links: https only, no credentials, no raw IPs or local names. */
export function safeLandingUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.') || /^[\d.]+$/.test(host) || host.includes(':') || host.startsWith('[')) return null;
  return u.toString();
}

/** A request body naming a forbidden targeting attribute is refused (used by the API schema and by the tests that walk the list). */
export const forbiddenTargetingKey = (obj) => Object.keys(obj ?? {}).find((k) => FORBIDDEN_TARGETING_KEYS.some((f) => k.toLowerCase().includes(f)));

/** A first-pass screen of the words in a creative. It only blocks the obvious; the review desk reads everything before it can run. */
const PROHIBITED_TERMS = {
  gambling_betting: ['betting', 'casino', 'poker', 'jackpot', 'sportsbook', 'wager'],
  tobacco_vaping: ['vape', 'vaping', 'cigarette', 'tobacco', 'hookah'],
  alcohol: ['whisky', 'whiskey', 'vodka', 'beer', 'cocktail'],
  performance_enhancing: ['steroid', 'anabolic', 'sarm', 'doping'],
  financial_speculation: ['crypto', 'forex', 'bitcoin', 'get rich'],
  high_cost_credit: ['payday loan'],
  weapons: ['firearm', 'ammunition'],
  adult_content: ['adult content', 'escort'],
};
export function screenCopy(...texts) {
  const hay = texts.filter(Boolean).join(' ').toLowerCase();
  for (const [category, terms] of Object.entries(PROHIBITED_TERMS)) {
    const hit = terms.find((t) => new RegExp(`\\b${t}\\b`).test(hay));
    if (hit) return { category, term: hit };
  }
  return null;
}
