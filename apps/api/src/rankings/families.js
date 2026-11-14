// Which native ranking model a sport uses (#507). A cricket innings is not a football half is not a tennis game is not a heat, so each family
// has its own set of formulas; a sport with no native family gets the generic metric ranking and is labelled as a fallback, never silently defaulted.

export const FAMILIES = {
  cricket:     { label: 'Cricket', native: true, kinds: ['metric', 'per_match', 'rating'], note: 'Runs, wickets and per-match rates from approved scorecards.' },
  goal_game:   { label: 'Goal games (football, futsal, hockey …)', native: true, kinds: ['metric', 'per_match', 'per_90', 'rating'], note: 'Goals and assists, per match or per 90 verified minutes.' },
  racket:      { label: 'Racket and set sports', native: true, kinds: ['metric', 'per_match', 'rating'], note: 'Match and set statistics from approved results.' },
  measured:    { label: 'Timed events (running, swimming, rowing …)', native: true, kinds: ['metric', 'rating'], note: 'Best or average time; lower is better.' },
  track_field: { label: 'Track and field (distance / weight events)', native: true, kinds: ['metric', 'rating'], note: 'Best valid attempt distance or weight; higher is better. Valid-attempt and personal-best moments are detected from session events.' },
  judged:      { label: 'Judged sports (gymnastics, diving, figure skating …)', native: true, kinds: ['metric', 'rating'], note: 'Highest panel score from an approved session. Score-announced and routine-complete moments are detected from session events.' },
  generic:     { label: 'Generic metric ranking (fallback)', native: false, kinds: ['metric', 'rating'], note: 'This sport has no dedicated model yet: it ranks one governed metric. Labelled as a fallback.' },
  team_form:   { label: 'Team form', native: true, kinds: ['team_form'], note: 'Points per game from completed fixtures.' },
};

/** The player-ranking family for a sport row ({ slug, scoring, category }). */
export function familyOf(sport) {
  if (/^cricket/.test(sport.slug ?? '')) return 'cricket';
  if (sport.scoring === 'goals') return 'goal_game';
  if (sport.scoring === 'sets' || sport.category === 'racquet') return 'racket';
  if (sport.scoring === 'judged') return 'judged';
  if (sport.scoring === 'distance' || sport.scoring === 'weight') return 'track_field';
  if (sport.scoring === 'time') return 'measured';
  return 'generic';
}

export const kindsFor = (family) => FAMILIES[family]?.kinds ?? [];
