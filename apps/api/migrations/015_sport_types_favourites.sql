-- Sport "type" (team / individual / board & card / online esports) so pickers can filter instead of
-- scrolling a flat list, more catalogue entries (field, water, combat, mind games, esports titles), and
-- per-user favourite sports. Additive only: nothing is removed; existing rows only get play_type back-filled.

ALTER TABLE sports ADD COLUMN IF NOT EXISTS play_type text NOT NULL DEFAULT 'individual';
ALTER TABLE sports DROP CONSTRAINT IF EXISTS sports_play_type_check;
ALTER TABLE sports ADD CONSTRAINT sports_play_type_check CHECK (play_type IN ('team','individual','board','esports'));

INSERT INTO sports (slug, name, emoji, scoring, category, play_type, programmes) VALUES
 -- more team sports
 ('american-football','American football','🏈','points','team_ball','team','{}'),
 ('australian-rules','Australian rules football','🏉','points','team_ball','team','{}'),
 ('gaelic-football','Gaelic football','⚽','points','team_ball','team','{}'),
 ('hurling','Hurling','🏑','points','team_ball','team','{}'),
 ('beach-soccer','Beach soccer','⚽','goals','team_ball','team','{}'),
 ('beach-handball','Beach handball','🤾','goals','team_ball','team','{}'),
 ('field-hockey-indoor','Indoor hockey','🏑','goals','team_ball','team','{}'),
 ('roller-hockey','Roller hockey','🏒','goals','team_ball','team','{}'),
 ('floorball','Floorball','🏑','goals','team_ball','team','{}'),
 ('bandy','Bandy','🏒','goals','winter','team','{}'),
 ('korfball','Korfball','🏐','goals','team_ball','team','{}'),
 ('ultimate-frisbee','Ultimate frisbee','🥏','points','team_ball','team','{}'),
 ('dodgeball','Dodgeball','🏐','points','team_ball','team','{}'),
 ('kho-kho','Kho kho','🏃','points','team_ball','team','{}'),
 ('rounders','Rounders','⚾','points','team_ball','team','{}'),
 ('polo','Polo','🏇','goals','equestrian','team','{}'),
 ('sitting-volleyball','Sitting volleyball','🏐','sets','team_ball','team','{}'),
 ('wheelchair-basketball','Wheelchair basketball','🏀','points','team_ball','team','{}'),
 ('table-soccer','Table football','⚽','goals','team_ball','team','{}'),
 ('relay-running','Relay running','🏃','time','athletics','team','{}'),
 ('team-pursuit-cycling','Team pursuit cycling','🚴','time','cycling','team','{}'),
 -- more individual sports
 ('running','Running','🏃','time','athletics','individual','{}'),
 ('trail-running','Trail running','🏃','time','athletics','individual','{}'),
 ('hiking','Hiking','🥾','distance','action','individual','{}'),
 ('parkour','Parkour','🤸','judged','action','individual','{}'),
 ('crossfit','CrossFit','🏋️','points','strength','individual','{}'),
 ('calisthenics','Calisthenics','💪','points','strength','individual','{}'),
 ('pilates','Pilates','🧘','points','action','individual','{}'),
 ('zumba','Zumba / dance fitness','💃','points','action','individual','{}'),
 ('aikido','Aikido','🥋','points','combat','individual','{}'),
 ('kung-fu','Kung fu','🥋','judged','combat','individual','{}'),
 ('muay-thai','Muay Thai','🥊','combat','combat','individual','{}'),
 ('mma','Mixed martial arts','🥊','combat','combat','individual','{}'),
 ('sumo','Sumo','🤼','combat','combat','individual','{}'),
 ('kendo','Kendo','🤺','combat','combat','individual','{}'),
 ('freediving','Freediving','🤿','distance','aquatics','individual','{}'),
 ('open-water-swimming','Open water swimming','🏊','time','aquatics','individual','{}'),
 ('water-skiing','Water skiing','🎿','judged','water','individual','{}'),
 ('wakeboarding','Wakeboarding','🏄','judged','water','individual','{}'),
 ('stand-up-paddleboarding','Stand-up paddleboarding','🏄','time','water','individual','{}'),
 ('kayaking','Kayaking','🛶','time','water','individual','{}'),
 ('white-water-rafting','White-water rafting','🛶','time','water','individual','{}'),
 ('skydiving','Skydiving','🪂','judged','action','individual','{}'),
 ('paragliding','Paragliding','🪂','distance','action','individual','{}'),
 ('rock-climbing-bouldering','Bouldering','🧗','points','action','individual','{}'),
 ('karting','Karting','🏎️','time','motorsport','individual','{}'),
 ('formula-racing','Formula racing','🏎️','time','motorsport','individual','{}'),
 ('motocross','Motocross','🏍️','time','motorsport','individual','{}'),
 ('disc-golf','Disc golf','🥏','points','precision','individual','{}'),
 ('petanque','Pétanque','⚪','points','precision','individual','{}'),
 ('lawn-bowls','Lawn bowls','⚪','points','precision','individual','{}'),
 ('boccia','Boccia','⚪','points','precision','individual','{}'),
 ('croquet','Croquet','🏑','points','precision','individual','{}'),
 ('cornhole','Cornhole','🎯','points','precision','individual','{}'),
 ('air-hockey','Air hockey','🏒','points','racquet','individual','{}'),
 ('racquetball','Racquetball','🎾','sets','racquet','individual','{}'),
 ('beach-tennis','Beach tennis','🎾','sets','racquet','individual','{}'),
 ('speedminton','Speedminton','🏸','sets','racquet','individual','{}'),
 ('javelin-throw','Javelin throw','🏃','distance','athletics','individual','{}'),
 ('shot-put','Shot put','🏃','distance','athletics','individual','{}'),
 ('high-jump','High jump','🏃','distance','athletics','individual','{}'),
 ('long-jump','Long jump','🏃','distance','athletics','individual','{}'),
 ('pole-vault','Pole vault','🏃','distance','athletics','individual','{}'),
 ('decathlon','Decathlon / heptathlon','🏃','points','athletics','individual','{}'),
 ('ice-climbing','Ice climbing','🧗','time','winter','individual','{}'),
 ('snowshoeing','Snowshoeing','🥾','time','winter','individual','{}'),
 ('sledding','Sledding','🛷','time','winter','individual','{}'),
 -- board, card & mind games
 ('checkers','Checkers / draughts','⛀','points','mind','board','{}'),
 ('shogi','Shogi','♟️','points','mind','board','{}'),
 ('backgammon','Backgammon','🎲','points','mind','board','{}'),
 ('carrom','Carrom','🎯','points','mind','board','{}'),
 ('ludo','Ludo','🎲','points','mind','board','{}'),
 ('scrabble','Scrabble','🔤','points','mind','board','{}'),
 ('othello','Othello / reversi','⚫','points','mind','board','{}'),
 ('mahjong','Mahjong','🀄','points','mind','board','{}'),
 ('poker','Poker','🃏','points','mind','board','{}'),
 ('rummy','Rummy','🃏','points','mind','board','{}'),
 ('uno','Uno','🃏','points','mind','board','{}'),
 ('dominoes','Dominoes','🁢','points','mind','board','{}'),
 ('monopoly','Monopoly','🎩','points','mind','board','{}'),
 ('catan','Catan','🎲','points','mind','board','{}'),
 ('sudoku','Sudoku','🔢','time','mind','board','{}'),
 ('rubiks-cube','Rubik''s cube (speedcubing)','🧩','time','mind','board','{}'),
 ('trivia-quiz','Trivia / quiz','❓','points','mind','board','{}'),
 ('tabletop-rpg','Tabletop games','🎲','points','mind','board','{}'),
 -- online games / esports
 ('valorant','Valorant','🎮','points','esports','esports','{}'),
 ('counter-strike','Counter-Strike 2','🎮','points','esports','esports','{}'),
 ('dota-2','Dota 2','🎮','points','esports','esports','{}'),
 ('league-of-legends','League of Legends','🎮','points','esports','esports','{}'),
 ('fortnite','Fortnite','🎮','points','esports','esports','{}'),
 ('pubg','PUBG / BGMI','🎮','points','esports','esports','{}'),
 ('free-fire','Free Fire','🎮','points','esports','esports','{}'),
 ('call-of-duty','Call of Duty','🎮','points','esports','esports','{}'),
 ('apex-legends','Apex Legends','🎮','points','esports','esports','{}'),
 ('overwatch','Overwatch','🎮','points','esports','esports','{}'),
 ('rocket-league','Rocket League','🚗','goals','esports','esports','{}'),
 ('ea-fc','EA FC / eFootball','🎮','goals','esports','esports','{}'),
 ('nba-2k','NBA 2K','🎮','points','esports','esports','{}'),
 ('mobile-legends','Mobile Legends','🎮','points','esports','esports','{}'),
 ('honor-of-kings','Honor of Kings','🎮','points','esports','esports','{}'),
 ('clash-royale','Clash Royale','🎮','points','esports','esports','{}'),
 ('street-fighter','Street Fighter','🎮','points','esports','esports','{}'),
 ('tekken','Tekken','🎮','points','esports','esports','{}'),
 ('super-smash-bros','Super Smash Bros.','🎮','points','esports','esports','{}'),
 ('hearthstone','Hearthstone','🎮','points','esports','esports','{}'),
 ('starcraft','StarCraft','🎮','points','esports','esports','{}'),
 ('online-chess','Online chess','♟️','points','esports','esports','{}'),
 ('sim-racing','Sim racing','🏎️','time','esports','esports','{}'),
 ('virtual-cycling','Virtual cycling','🚴','time','esports','esports','{}'),
 ('mobile-games','Mobile games','📱','points','esports','esports','{}')
ON CONFLICT (slug) DO NOTHING;

-- back-fill play_type on every row that already existed
UPDATE sports SET play_type = 'team'
 WHERE category = 'team_ball'
    OR slug IN ('ice-hockey','curling','dragon-boat','canoe-polo','water-polo','rugby','rugby-sevens','bobsleigh');
UPDATE sports SET play_type = 'board' WHERE slug IN ('chess','xiangqi','go','contract-bridge');
UPDATE sports SET play_type = 'esports' WHERE slug = 'esports' OR category = 'esports';

-- favourite sports (soft delete: un-favouriting keeps the row)
CREATE TABLE IF NOT EXISTS favourite_sports (
  user_id    uuid NOT NULL REFERENCES users,
  sport_id   uuid NOT NULL REFERENCES sports,
  created_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  PRIMARY KEY (user_id, sport_id)
);
CREATE INDEX IF NOT EXISTS favourite_sports_user ON favourite_sports (user_id) WHERE removed_at IS NULL;
