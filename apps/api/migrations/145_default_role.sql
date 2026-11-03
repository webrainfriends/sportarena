-- The role a person lands in. Nullable and additive: NULL means "athlete if held, else the first role"
-- (see src/default-role.js). Nothing is rewritten or dropped.
ALTER TABLE users ADD COLUMN IF NOT EXISTS default_role text;
