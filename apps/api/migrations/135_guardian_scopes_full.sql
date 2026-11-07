-- Extend guardian link default scopes to match the full SCOPES list in youth.js (issue #604).
-- social and pickup were added to SCOPES after migration 134 ran, so the column default was stale.
-- Backfills all existing rows that are missing either scope; additive and backwards-compatible.
ALTER TABLE guardian_links ALTER COLUMN scopes SET DEFAULT '{pay,register,rsvp,travel_consent,consent,calendar,social,pickup}';
UPDATE guardian_links
   SET scopes = array(SELECT DISTINCT unnest(scopes || '{social,pickup}'::text[]) ORDER BY 1)
 WHERE NOT (scopes @> '{social,pickup}'::text[]);
