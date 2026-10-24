// Optional "who is this for" fields shared by team posts, events and programmes so a player's card can be compared with
// them (opportunity matching, #316). Unstated stays unstated: the matcher reports it as missing data, never as a match.
import { z } from 'zod';

export const LEVELS = ['beginner', 'amateur', 'semi_pro', 'pro'];
export const AGE = { min_age: z.number().int().min(3).max(99).optional(), max_age: z.number().int().min(3).max(99).optional() };
export const levels = z.array(z.enum(LEVELS)).max(4);
export const WHO_FOR = { positions: z.array(z.string().trim().min(1).max(40)).max(12).default([]), levels: levels.default([]), region: z.string().trim().max(80).optional(), ...AGE };
export const ageBand = (v) => v.min_age == null || v.max_age == null || v.max_age >= v.min_age;
export const AGE_BAND_MSG = { message: 'max_age is below min_age', path: ['max_age'] };
