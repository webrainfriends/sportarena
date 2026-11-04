// The kit an athlete is fitted for, by slot, and which slots each sport family suggests (#798). A cricket whites set is not a goalkeeper's gloves
// is not a racket: each native family gets its own suggestions and any other sport gets the common wardrobe, labelled as a fallback - never silently.
// The slots are suggestions for the entitlement form; a stock row may carry any slot from this list (or none).
import { familyOf } from './rankings/families.js';

export const KIT_SLOTS = {
  shirt: 'Match / home shirt', training_top: 'Training top', shorts: 'Shorts', skirt: 'Skirt / skort', socks: 'Socks', jacket: 'Jacket / tracksuit', rain_jacket: 'Rain jacket', bag: 'Kit bag',
  footwear: 'Boots / shoes', shin_pads: 'Shin pads', gloves: 'Gloves', keeper_kit: 'Goalkeeper kit', bib: 'Training bib',
  racket: 'Racket', grip_overgrip: 'Grips / strings pack', cap_visor: 'Cap / visor', wristband: 'Wristbands / headband',
  whites_shirt: 'Whites shirt', whites_trousers: 'Whites trousers', sweater: 'Sweater', cricket_pads: 'Batting pads', cricket_gloves: 'Batting gloves', helmet: 'Helmet', bat: 'Bat',
  swimsuit: 'Swimsuit', swim_cap: 'Swim cap', goggles: 'Goggles', spikes: 'Spikes', singlet: 'Singlet / race vest', tracker: 'GPS / heart-rate tracker',
  protective: 'Protective gear', other: 'Other kit',
};
export const SLOT_KEYS = Object.keys(KIT_SLOTS);

const COMMON = ['shirt', 'training_top', 'shorts', 'socks', 'jacket', 'bag'];
const BY_FAMILY = {
  goal_game: [...COMMON, 'footwear', 'shin_pads', 'keeper_kit', 'bib', 'tracker'],
  racket: ['shirt', 'shorts', 'skirt', 'socks', 'jacket', 'cap_visor', 'wristband', 'footwear', 'racket', 'grip_overgrip', 'bag'],
  cricket: ['whites_shirt', 'whites_trousers', 'sweater', 'cap_visor', 'socks', 'footwear', 'cricket_pads', 'cricket_gloves', 'helmet', 'bat', 'bag'],
  measured: ['singlet', 'shorts', 'training_top', 'jacket', 'spikes', 'swimsuit', 'swim_cap', 'goggles', 'tracker', 'bag'],
};

/**
 * Suggested slots for a sport row ({ slug, scoring, category }). `native` is false for the common-wardrobe fallback, so the app can say so.
 * Combat, aquatic, winter and other families that have no dedicated list yet are a labelled fallback (reported as a gap in the PR), not a silent default.
 */
export function slotsForSport(sport) {
  const family = familyOf(sport);
  const list = BY_FAMILY[family];
  return { family, native: !!list, slots: (list ?? [...COMMON, 'footwear', 'protective', 'tracker', 'other']).map((key) => ({ key, label: KIT_SLOTS[key] })) };
}
