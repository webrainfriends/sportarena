// Which rating model a sport uses (#633). Same families as the rankings (rankings/families.js) so there is one notion of "what kind of sport this is";
// each family says how a verified game becomes a rating score. A sport with no native model is rated on win/loss only and is labelled as such.
import { familyOf } from '../rankings/families.js';

export const MODELS = {
  racket:    { label: 'Racket and set sports', native: true, margin: 'points', note: 'Singles and doubles from approved scorecards: the sets won and the points inside them, against the opposing side’s average level.' },
  goal_game: { label: 'Goal games (football, futsal, hockey …)', native: true, margin: 'goals', note: 'Team results from approved fixtures, credited to the players with a verified appearance on the day.' },
  cricket:   { label: 'Cricket', native: true, margin: 'runs', note: 'Approved match results, credited to the players with a verified appearance, with the run margin.' },
  measured:  { label: 'Timed and measured events', native: true, margin: null, note: 'Your finishing place against everyone else in the same heat or final, from completed event sessions.' },
  generic:   { label: 'Win/loss only (fallback)', native: false, margin: null, note: 'This sport has no dedicated rating model yet: only who won counts, not the margin. Labelled as a fallback.' },
};

/** The rating model for a sport row ({ slug, scoring, category }). */
export const modelOf = (sport) => familyOf(sport);
export const describeModel = (family) => ({ family, ...(MODELS[family] ?? MODELS.generic) });

/** Whether a game's margin (points, goals, runs) is part of the score for this family. */
export const usesMargin = (family) => !!MODELS[family]?.margin;
