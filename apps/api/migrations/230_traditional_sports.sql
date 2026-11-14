-- Adds traditional and regional sports not previously in the catalogue.
-- Kho-kho is already present (migration 015). Kabaddi, judo, wrestling, boxing and fencing
-- are in the Olympic/Asian Games catalogue (migration 006).
-- Additive only: no existing rows are modified.

INSERT INTO sports (slug, name, emoji, scoring, category, play_type, programmes) VALUES
  ('ball-badminton', 'Ball Badminton', '🏸', 'sets',   'racquet',     'individual', '{asian_games}'),
  ('silambam',       'Silambam',       '🥋', 'combat', 'combat',      'individual', '{}'),
  ('jallikattu',     'Jallikattu',     '🐂', 'points', 'traditional', 'individual', '{}'),
  ('manju-virattu',  'Manju Virattu',  '🐂', 'points', 'traditional', 'individual', '{}')
ON CONFLICT (slug) DO NOTHING;
