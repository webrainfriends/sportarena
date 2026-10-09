-- A profile photo may be a transparent cut-out (background removed in the browser); the app then draws it large on the player card.
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_cutout boolean NOT NULL DEFAULT false;
