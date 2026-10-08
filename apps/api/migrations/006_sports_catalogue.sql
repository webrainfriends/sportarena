-- Full sports catalogue: every sport/discipline on the Olympic (summer + winter) and Asian Games programmes,
-- so every persona and module (all of which reference sports(id)) can use them. Additive only: no rows are
-- removed, and existing rows keep their name/emoji/scoring (only category + programmes are back-filled).

ALTER TABLE sports
  ADD COLUMN IF NOT EXISTS category   text,
  ADD COLUMN IF NOT EXISTS programmes text[] NOT NULL DEFAULT '{}';

-- widen (never narrow) the scoring vocabulary: judged panels, weight lifted, bout points
ALTER TABLE sports DROP CONSTRAINT IF EXISTS sports_scoring_check;
ALTER TABLE sports ADD CONSTRAINT sports_scoring_check
  CHECK (scoring IN ('points','time','distance','goals','sets','judged','weight','combat'));

-- programmes: olympic_summer, olympic_winter, asian_games
INSERT INTO sports (slug, name, emoji, scoring, category, programmes) VALUES
 -- team ball sports
 ('football','Football','⚽','goals','team_ball','{olympic_summer,asian_games}'),
 ('basketball','Basketball','🏀','points','team_ball','{olympic_summer,asian_games}'),
 ('3x3-basketball','3x3 Basketball','🏀','points','team_ball','{olympic_summer,asian_games}'),
 ('volleyball','Volleyball','🏐','sets','team_ball','{olympic_summer,asian_games}'),
 ('beach-volleyball','Beach volleyball','🏐','sets','team_ball','{olympic_summer,asian_games}'),
 ('handball','Handball','🤾','goals','team_ball','{olympic_summer,asian_games}'),
 ('hockey','Hockey','🏑','goals','team_ball','{olympic_summer,asian_games}'),
 ('rugby','Rugby','🏉','points','team_ball','{}'),
 ('rugby-sevens','Rugby sevens','🏉','points','team_ball','{olympic_summer,asian_games}'),
 ('water-polo','Water polo','🤽','goals','team_ball','{olympic_summer,asian_games}'),
 ('cricket','Cricket','🏏','points','team_ball','{olympic_summer,asian_games}'),
 ('softball','Softball','🥎','points','team_ball','{olympic_summer,asian_games}'),
 ('baseball','Baseball','⚾','points','team_ball','{olympic_summer,asian_games}'),
 ('lacrosse','Lacrosse','🥍','goals','team_ball','{olympic_summer}'),
 ('kabaddi','Kabaddi','🤼','points','team_ball','{asian_games}'),
 ('sepak-takraw','Sepak takraw','🏐','sets','team_ball','{asian_games}'),
 ('futsal','Futsal','⚽','goals','team_ball','{}'),
 ('netball','Netball','🏐','goals','team_ball','{}'),
 ('tug-of-war','Tug of war','🪢','points','team_ball','{}'),
 -- racquet / net
 ('tennis','Tennis','🎾','sets','racquet','{olympic_summer,asian_games}'),
 ('soft-tennis','Soft tennis','🎾','sets','racquet','{asian_games}'),
 ('badminton','Badminton','🏸','sets','racquet','{olympic_summer,asian_games}'),
 ('table-tennis','Table tennis','🏓','sets','racquet','{olympic_summer,asian_games}'),
 ('squash','Squash','🎾','sets','racquet','{olympic_summer,asian_games}'),
 ('padel','Padel','🎾','sets','racquet','{}'),
 ('pickleball','Pickleball','🏓','sets','racquet','{}'),
 -- athletics & multi-sport
 ('athletics','Athletics','🏃','time','athletics','{olympic_summer,asian_games}'),
 ('marathon','Marathon','🏃','time','athletics','{olympic_summer,asian_games}'),
 ('race-walking','Race walking','🚶','time','athletics','{olympic_summer,asian_games}'),
 ('triathlon','Triathlon','🏊','time','athletics','{olympic_summer,asian_games}'),
 ('modern-pentathlon','Modern pentathlon','🤺','points','athletics','{olympic_summer,asian_games}'),
 -- aquatics
 ('swimming','Swimming','🏊','time','aquatics','{olympic_summer,asian_games}'),
 ('marathon-swimming','Marathon swimming','🏊','time','aquatics','{olympic_summer,asian_games}'),
 ('diving','Diving','🤿','judged','aquatics','{olympic_summer,asian_games}'),
 ('artistic-swimming','Artistic swimming','🏊','judged','aquatics','{olympic_summer,asian_games}'),
 -- gymnastics & judged
 ('gymnastics','Gymnastics','🤸','judged','gymnastics','{olympic_summer,asian_games}'),
 ('artistic-gymnastics','Artistic gymnastics','🤸','judged','gymnastics','{olympic_summer,asian_games}'),
 ('rhythmic-gymnastics','Rhythmic gymnastics','🎀','judged','gymnastics','{olympic_summer,asian_games}'),
 ('trampoline','Trampoline','🤸','judged','gymnastics','{olympic_summer,asian_games}'),
 ('aerobic-gymnastics','Aerobic gymnastics','🤸','judged','gymnastics','{}'),
 ('breaking','Breaking','🕺','judged','gymnastics','{olympic_summer,asian_games}'),
 ('dancesport','Dancesport','💃','judged','gymnastics','{asian_games}'),
 -- combat
 ('boxing','Boxing','🥊','combat','combat','{olympic_summer,asian_games}'),
 ('judo','Judo','🥋','combat','combat','{olympic_summer,asian_games}'),
 ('karate','Karate','🥋','combat','combat','{olympic_summer,asian_games}'),
 ('taekwondo','Taekwondo','🥋','combat','combat','{olympic_summer,asian_games}'),
 ('wrestling','Wrestling','🤼','combat','combat','{olympic_summer,asian_games}'),
 ('fencing','Fencing','🤺','combat','combat','{olympic_summer,asian_games}'),
 ('wushu','Wushu','🥋','judged','combat','{asian_games}'),
 ('sambo','Sambo','🥋','combat','combat','{}'),
 ('ju-jitsu','Ju-jitsu','🥋','combat','combat','{asian_games}'),
 ('kurash','Kurash','🤼','combat','combat','{asian_games}'),
 ('pencak-silat','Pencak silat','🥋','combat','combat','{asian_games}'),
 ('kickboxing','Kickboxing','🥊','combat','combat','{}'),
 ('martial-arts','Martial arts','🥋','points','combat','{}'),
 -- strength
 ('weightlifting','Weightlifting','🏋️','weight','strength','{olympic_summer,asian_games}'),
 ('powerlifting','Powerlifting','🏋️','weight','strength','{}'),
 ('bodybuilding','Bodybuilding','💪','judged','strength','{asian_games}'),
 ('fitness','Fitness / gym','🏋️','points','strength','{}'),
 -- cycling
 ('cycling','Cycling (road)','🚴','time','cycling','{olympic_summer,asian_games}'),
 ('track-cycling','Track cycling','🚴','time','cycling','{olympic_summer,asian_games}'),
 ('mountain-biking','Mountain biking','🚵','time','cycling','{olympic_summer,asian_games}'),
 ('bmx-racing','BMX racing','🚴','time','cycling','{olympic_summer,asian_games}'),
 ('bmx-freestyle','BMX freestyle','🚴','judged','cycling','{olympic_summer,asian_games}'),
 -- water & boat
 ('rowing','Rowing','🚣','time','water','{olympic_summer,asian_games}'),
 ('canoe-sprint','Canoe sprint','🛶','time','water','{olympic_summer,asian_games}'),
 ('canoe-slalom','Canoe slalom','🛶','time','water','{olympic_summer,asian_games}'),
 ('sailing','Sailing','⛵','points','water','{olympic_summer,asian_games}'),
 ('windsurfing','Windsurfing','🏄','points','water','{olympic_summer}'),
 ('kitesurfing','Kitesurfing','🪁','points','water','{olympic_summer}'),
 ('surfing','Surfing','🏄','judged','water','{olympic_summer,asian_games}'),
 ('dragon-boat','Dragon boat','🐉','time','water','{asian_games}'),
 ('canoe-polo','Canoe polo','🛶','goals','water','{}'),
 -- equestrian
 ('equestrian','Equestrian','🏇','judged','equestrian','{olympic_summer,asian_games}'),
 -- precision / shooting
 ('shooting','Shooting','🔫','points','precision','{olympic_summer,asian_games}'),
 ('archery','Archery','🏹','points','precision','{olympic_summer,asian_games}'),
 ('golf','Golf','⛳','points','precision','{olympic_summer,asian_games}'),
 ('bowling','Bowling','🎳','points','precision','{asian_games}'),
 ('darts','Darts','🎯','points','precision','{}'),
 ('snooker','Snooker','🎱','points','precision','{}'),
 ('pool','Pool / billiards','🎱','points','precision','{asian_games}'),
 -- climbing & action
 ('climbing','Climbing','🧗','time','action','{olympic_summer,asian_games}'),
 ('skateboarding','Skateboarding','🛹','points','action','{olympic_summer,asian_games}'),
 ('roller-sports','Roller sports','🛼','time','action','{asian_games}'),
 ('yoga','Yoga','🧘','points','action','{}'),
 -- mind sports & esports
 ('chess','Chess','♟️','points','mind','{asian_games}'),
 ('xiangqi','Xiangqi','♟️','points','mind','{asian_games}'),
 ('go','Go (weiqi / baduk)','⚫','points','mind','{asian_games}'),
 ('contract-bridge','Contract bridge','🃏','points','mind','{asian_games}'),
 ('esports','Esports','🎮','points','mind','{asian_games}'),
 -- motorsport
 ('motorsport','Motorsport','🏎️','time','motorsport','{}'),
 -- winter sports
 ('alpine-skiing','Alpine skiing','⛷️','time','winter','{olympic_winter,asian_games}'),
 ('cross-country-skiing','Cross-country skiing','⛷️','time','winter','{olympic_winter,asian_games}'),
 ('ski-jumping','Ski jumping','⛷️','distance','winter','{olympic_winter}'),
 ('nordic-combined','Nordic combined','⛷️','time','winter','{olympic_winter}'),
 ('freestyle-skiing','Freestyle skiing','⛷️','judged','winter','{olympic_winter}'),
 ('snowboarding','Snowboarding','🏂','judged','winter','{olympic_winter}'),
 ('biathlon','Biathlon','🎿','time','winter','{olympic_winter}'),
 ('ski-mountaineering','Ski mountaineering','⛷️','time','winter','{olympic_winter}'),
 ('speed-skating','Speed skating','⛸️','time','winter','{olympic_winter,asian_games}'),
 ('short-track','Short track speed skating','⛸️','time','winter','{olympic_winter,asian_games}'),
 ('figure-skating','Figure skating','⛸️','judged','winter','{olympic_winter,asian_games}'),
 ('skating','Skating','⛸️','time','winter','{}'),
 ('ice-hockey','Ice hockey','🏒','goals','winter','{olympic_winter,asian_games}'),
 ('curling','Curling','🥌','points','winter','{olympic_winter,asian_games}'),
 ('bobsleigh','Bobsleigh','🛷','time','winter','{olympic_winter}'),
 ('luge','Luge','🛷','time','winter','{olympic_winter}'),
 ('skeleton','Skeleton','🛷','time','winter','{olympic_winter}')
ON CONFLICT (slug) DO UPDATE SET category = EXCLUDED.category, programmes = EXCLUDED.programmes;
