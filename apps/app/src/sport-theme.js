// One look per sport, so a sport's card carries its mood: the colours of the venue, the energy of the game and the words its players use.
// tone: [solid, soft tint, deep text-on-tint] · grad: hero gradient · motif: watermark emoji · radius: card corner (soft = calm, sharp = fierce)
// noun/verb: what a "match" is called in that sport · draws: whether W-D-L or just W-L makes sense · vibe: one line of mood.

const t = (solid, soft, deep, g2) => ({ tone: [solid, soft, deep], grad: [solid, g2] });

const FAMILIES = {
  water:    { ...t('#0284C7', '#E0F2FE', '#075985', '#06B6D4'), motif: '🌊', radius: 26, noun: 'RACES', one: 'race', draws: false, vibe: 'Cool, fast and fluid' },
  court:    { ...t('#16A34A', '#DCFCE7', '#166534', '#84CC16'), motif: '🏸', radius: 22, noun: 'MATCHES', one: 'match', draws: false, vibe: 'Quick feet, sharp reflexes' },
  pitch:    { ...t('#15803D', '#DCFCE7', '#14532D', '#22C55E'), motif: '⚽', radius: 20, noun: 'MATCHES', one: 'match', draws: true, vibe: 'Floodlights and a roaring crowd' },
  hardwood: { ...t('#EA580C', '#FFEDD5', '#9A3412', '#F59E0B'), motif: '🏀', radius: 18, noun: 'GAMES', one: 'game', draws: false, vibe: 'High tempo, loud and electric' },
  beach:    { ...t('#F59E0B', '#FEF3C7', '#92400E', '#FB7185'), motif: '🏐', radius: 28, noun: 'MATCHES', one: 'match', draws: false, vibe: 'Sun, sand and summer energy' },
  combat:   { ...t('#B91C1C', '#FEE2E2', '#7F1D1D', '#1F2937'), motif: '🥊', radius: 10, noun: 'BOUTS', one: 'bout', draws: true, vibe: 'Raw, intense and disciplined' },
  track:    { ...t('#DC2626', '#FEE2E2', '#991B1B', '#F97316'), motif: '🏃', radius: 16, noun: 'RACES', one: 'race', draws: false, vibe: 'Pure speed, every second counts' },
  wheels:   { ...t('#0891B2', '#CFFAFE', '#155E75', '#2563EB'), motif: '🚴', radius: 18, noun: 'RIDES', one: 'ride', draws: false, vibe: 'Open road and rushing wind' },
  racing:   { ...t('#E11D48', '#FFE4E6', '#9F1239', '#111827'), motif: '🏎️', radius: 8, noun: 'RACES', one: 'race', draws: false, vibe: 'Adrenaline, engines and podiums' },
  ice:      { ...t('#0EA5E9', '#E0F2FE', '#0C4A6E', '#A5B4FC'), motif: '❄️', radius: 24, noun: 'GAMES', one: 'game', draws: true, vibe: 'Crisp, cold and clean lines' },
  snow:     { ...t('#6366F1', '#E0E7FF', '#3730A3', '#38BDF8'), motif: '🏔️', radius: 26, noun: 'RUNS', one: 'run', draws: false, vibe: 'Fresh powder, big air' },
  precision:{ ...t('#047857', '#D1FAE5', '#064E3B', '#0F766E'), motif: '🎯', radius: 14, noun: 'ROUNDS', one: 'round', draws: false, vibe: 'Calm focus, steady hands' },
  mind:     { ...t('#7C3AED', '#EDE9FE', '#4C1D95', '#1E1B4B'), motif: '♟️', radius: 12, noun: 'GAMES', one: 'game', draws: true, vibe: 'Quiet, sharp and strategic' },
  digital:  { ...t('#8B5CF6', '#F3E8FF', '#5B21B6', '#06B6D4'), motif: '🎮', radius: 14, noun: 'MATCHES', one: 'match', draws: false, vibe: 'Neon, fast and competitive' },
  strength: { ...t('#475569', '#E2E8F0', '#1E293B', '#F59E0B'), motif: '🏋️', radius: 10, noun: 'SESSIONS', one: 'session', draws: false, vibe: 'Iron, grit and personal bests' },
  grace:    { ...t('#DB2777', '#FCE7F3', '#9D174D', '#A855F7'), motif: '🤸', radius: 30, noun: 'ROUTINES', one: 'routine', draws: false, vibe: 'Poise, rhythm and artistry' },
  calm:     { ...t('#0D9488', '#CCFBF1', '#115E59', '#A3E635'), motif: '🧘', radius: 30, noun: 'SESSIONS', one: 'session', draws: false, vibe: 'Breathe, balance and flow' },
  earth:    { ...t('#B45309', '#FEF3C7', '#78350F', '#65A30D'), motif: '🧗', radius: 14, noun: 'CLIMBS', one: 'climb', draws: false, vibe: 'Rock, chalk and grit' },
  bat:      { ...t('#CA8A04', '#FEF9C3', '#713F12', '#16A34A'), motif: '🏏', radius: 18, noun: 'MATCHES', one: 'match', draws: true, vibe: 'Whites on green, a long afternoon' },
  clay:     { ...t('#C2410C', '#FFEDD5', '#7C2D12', '#FACC15'), motif: '🎾', radius: 20, noun: 'MATCHES', one: 'match', draws: false, vibe: 'Clay dust and baseline battles' },
  club:     { ...t('#8458B3', '#E5EAF5', '#494D5F', '#D0BDF4'), motif: '🏅', radius: 20, noun: 'MATCHES', one: 'match', draws: true, vibe: 'Your game, your colours' },
};

const MEMBERS = {
  water: 'swimming marathon-swimming diving artistic-swimming water-polo canoe-polo rowing canoe-sprint canoe-slalom sailing windsurfing kitesurfing surfing dragon-boat triathlon',
  court: 'badminton table-tennis squash padel pickleball soft-tennis sepak-takraw',
  clay: 'tennis',
  pitch: 'football futsal rugby rugby-sevens hockey lacrosse kabaddi handball tug-of-war',
  hardwood: 'basketball 3x3-basketball netball',
  beach: 'volleyball beach-volleyball',
  bat: 'cricket softball baseball',
  combat: 'boxing judo karate taekwondo wrestling fencing wushu sambo ju-jitsu kurash pencak-silat kickboxing martial-arts',
  track: 'athletics marathon race-walking modern-pentathlon',
  wheels: 'cycling track-cycling mountain-biking bmx-racing bmx-freestyle skateboarding roller-sports',
  racing: 'motorsport',
  ice: 'ice-hockey curling speed-skating short-track figure-skating skating bobsleigh luge skeleton',
  snow: 'alpine-skiing cross-country-skiing ski-jumping nordic-combined freestyle-skiing snowboarding biathlon ski-mountaineering',
  precision: 'archery shooting golf bowling darts snooker pool equestrian',
  mind: 'chess xiangqi go contract-bridge',
  digital: 'esports',
  strength: 'weightlifting powerlifting bodybuilding fitness',
  grace: 'gymnastics artistic-gymnastics rhythmic-gymnastics trampoline aerobic-gymnastics breaking dancesport',
  calm: 'yoga',
  earth: 'climbing',
};

// per-sport colour overrides where the family colour would miss the sport's own character
const OVERRIDES = {
  swimming: { ...t('#0369A1', '#E0F2FE', '#0C4A6E', '#22D3EE'), motif: '🏊', vibe: 'Lane lines, chlorine and clean strokes' },
  diving: { motif: '🤿' },
  'water-polo': { motif: '🤽' },
  rowing: { motif: '🚣' },
  sailing: { motif: '⛵' },
  surfing: { motif: '🏄' },
  badminton: { ...t('#16A34A', '#DCFCE7', '#166534', '#A3E635'), motif: '🏸', vibe: 'Feather-light touch, lightning smashes' },
  'table-tennis': { ...t('#2563EB', '#DBEAFE', '#1E3A8A', '#EF4444'), motif: '🏓', vibe: 'Spin, speed and split-second rallies' },
  squash: { ...t('#1F2937', '#E5E7EB', '#111827', '#DC2626'), motif: '🎾', vibe: 'Walls, sweat and relentless pace' },
  padel: { ...t('#0891B2', '#CFFAFE', '#155E75', '#A3E635'), motif: '🎾' },
  pickleball: { ...t('#65A30D', '#ECFCCB', '#365314', '#FACC15'), motif: '🏓' },
  football: { motif: '⚽', vibe: 'Floodlights and a roaring crowd' },
  futsal: { ...t('#0F766E', '#CCFBF1', '#134E4A', '#22C55E'), motif: '⚽', vibe: 'Tight spaces, quick feet' },
  rugby: { ...t('#166534', '#DCFCE7', '#14532D', '#854D0E'), motif: '🏉' },
  'rugby-sevens': { motif: '🏉' },
  hockey: { motif: '🏑' },
  'ice-hockey': { motif: '🏒' },
  handball: { ...t('#2563EB', '#DBEAFE', '#1E3A8A', '#F97316'), motif: '🤾' },
  basketball: { vibe: 'Squeaking sneakers and buzzer beaters' },
  volleyball: { ...t('#0EA5E9', '#E0F2FE', '#075985', '#FACC15'), motif: '🏐', vibe: 'Rotations, spikes and team rhythm' },
  cricket: { vibe: 'Whites on green, a long afternoon' },
  baseball: { ...t('#1D4ED8', '#DBEAFE', '#1E3A8A', '#DC2626'), motif: '⚾' },
  softball: { motif: '🥎' },
  golf: { motif: '⛳', vibe: 'Fairways, patience and quiet putts' },
  bowling: { ...t('#7C3AED', '#EDE9FE', '#4C1D95', '#EC4899'), motif: '🎳' },
  darts: { ...t('#B91C1C', '#FEE2E2', '#7F1D1D', '#15803D'), motif: '🎯' },
  snooker: { ...t('#166534', '#DCFCE7', '#14532D', '#7F1D1D'), motif: '🎱', vibe: 'Green baize, hushed crowd' },
  pool: { ...t('#0F766E', '#CCFBF1', '#134E4A', '#1D4ED8'), motif: '🎱' },
  archery: { motif: '🏹' },
  equestrian: { ...t('#92400E', '#FEF3C7', '#78350F', '#65A30D'), motif: '🏇', vibe: 'Hoofbeats, trust and timing' },
  fencing: { ...t('#475569', '#E2E8F0', '#1E293B', '#38BDF8'), motif: '🤺', vibe: 'Steel, footwork and precision' },
  judo: { ...t('#1D4ED8', '#DBEAFE', '#1E3A8A', '#111827'), motif: '🥋' },
  karate: { motif: '🥋' },
  taekwondo: { motif: '🥋' },
  wrestling: { motif: '🤼' },
  boxing: { vibe: 'Ropes, rhythm and heart' },
  cycling: { motif: '🚴' },
  'mountain-biking': { motif: '🚵', ...t('#92400E', '#FEF3C7', '#78350F', '#15803D') },
  skateboarding: { motif: '🛹', ...t('#F97316', '#FFEDD5', '#9A3412', '#8B5CF6'), vibe: 'Concrete, style and kickflips' },
  'roller-sports': { motif: '🛼' },
  chess: { ...t('#334155', '#E2E8F0', '#0F172A', '#CA8A04'), motif: '♟️', vibe: 'Ink, silence and deep thought' },
  esports: { vibe: 'Neon, fast and competitive' },
  weightlifting: { motif: '🏋️' },
  yoga: { vibe: 'Breathe, balance and flow' },
  'alpine-skiing': { motif: '⛷️' },
  snowboarding: { motif: '🏂' },
  'figure-skating': { motif: '⛸️', ...t('#DB2777', '#FCE7F3', '#9D174D', '#818CF8') },
  curling: { motif: '🥌' },
  climbing: { motif: '🧗' },
  athletics: { motif: '🏃' },
  marathon: { motif: '🏃', vibe: 'Mile after mile, one stride at a time' },
  gymnastics: { motif: '🤸' },
  'rhythmic-gymnastics': { motif: '🎀' },
  breaking: { motif: '🕺', ...t('#EA580C', '#FFEDD5', '#9A3412', '#7C3AED'), vibe: 'Cyphers, bass and fresh moves' },
  dancesport: { motif: '💃' },
};

const FAMILY_OF = Object.fromEntries(Object.entries(MEMBERS).flatMap(([fam, list]) => list.split(' ').map((slug) => [slug, fam])));

export const HAS_SPORT_THEME = (slug) => !!(slug && (FAMILY_OF[slug] || OVERRIDES[slug]));

/** The full theme for a sport slug. Unknown sports get a neutral club look (not a random colour), so a new sport still renders fine. */
export function sportTheme(slug = '') {
  const base = FAMILIES[FAMILY_OF[slug] ?? 'club'];
  const o = OVERRIDES[slug];
  return o ? { ...base, ...o } : base;
}

/** "W-D-L" for sports that can draw (or have drawn), otherwise "W-L" — a swimmer or boxer never sees a draw column of zeros. */
export function recordOf(theme, s) {
  return theme.draws || s.draws > 0 ? `${s.wins}-${s.draws}-${s.losses}` : `${s.wins}-${s.losses}`;
}
export const recordLabel = (theme, s) => (theme.draws || s.draws > 0 ? 'W-D-L' : 'W-L');
