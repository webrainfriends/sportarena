-- Canonical Sports Graph (#561). Additive only: nothing is dropped, narrowed or rewritten, and nothing here deletes data.
-- The graph is a read layer over the canonical tables (users, organisations, teams, events, venues, career_memberships, player_contracts,
-- match_appearances, awards, clinical clearances ...). It never copies a person, team, event, payment or health record. These four tables hold
-- only what no canonical table holds today: effective-dated relationships between entities, name aliases, and verified external identifiers.
-- Edges are ended (valid_to / status), never deleted; every change appends a revision snapshot.

CREATE TABLE IF NOT EXISTS graph_edges (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_kind          text NOT NULL CHECK (from_kind IN ('person','organisation','team','event','venue')),
  from_id            uuid NOT NULL,
  rel                text NOT NULL CHECK (rel IN ('member_of','part_of','affiliated_with','represents','competes_in','based_at')),
  to_kind            text NOT NULL CHECK (to_kind IN ('person','organisation','team','event','venue')),
  to_id              uuid NOT NULL,
  valid_from         date NOT NULL,
  valid_to           date,
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended','withdrawn')),
  provenance         text NOT NULL DEFAULT 'manual' CHECK (provenance IN ('manual','imported','derived')),
  source_authority   text NOT NULL CHECK (source_authority IN ('self','organisation','counterparty','platform')),
  verification_state text NOT NULL DEFAULT 'unverified' CHECK (verification_state IN ('unverified','verified','rejected')),
  verified_by        uuid REFERENCES users,
  verified_at        timestamptz,
  external_ref       text CHECK (external_ref IS NULL OR length(external_ref) BETWEEN 1 AND 160),
  note               text CHECK (note IS NULL OR length(note) <= 500),
  row_version        int NOT NULL DEFAULT 1,
  idempotency_key    text CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 8 AND 80),
  created_by         uuid NOT NULL REFERENCES users,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CHECK (NOT (from_kind = to_kind AND from_id = to_id))
);
CREATE INDEX IF NOT EXISTS graph_edges_from ON graph_edges (from_kind, from_id, status, valid_from DESC);
CREATE INDEX IF NOT EXISTS graph_edges_to   ON graph_edges (to_kind, to_id, status, valid_from DESC);
CREATE UNIQUE INDEX IF NOT EXISTS graph_edges_idem ON graph_edges (created_by, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS graph_edge_revisions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  edge_id     uuid NOT NULL REFERENCES graph_edges,
  row_version int NOT NULL,
  action      text NOT NULL CHECK (action IN ('created','corrected','ended','withdrawn','verified','rejected')),
  snapshot    jsonb NOT NULL,
  reason      text CHECK (reason IS NULL OR length(reason) <= 500),
  actor_id    uuid REFERENCES users,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS graph_edge_revisions_edge ON graph_edge_revisions (edge_id, created_at);

-- Name variants. Searching matches an alias, but an alias never merges two identities.
CREATE TABLE IF NOT EXISTS graph_aliases (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL CHECK (kind IN ('person','organisation','team','event','venue')),
  entity_id   uuid NOT NULL,
  alias       text NOT NULL CHECK (length(alias) BETWEEN 2 AND 120),
  alias_key   text NOT NULL,
  language    text CHECK (language IS NULL OR language ~ '^[a-z]{2,3}$'),
  created_by  uuid NOT NULL REFERENCES users,
  created_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS graph_aliases_live ON graph_aliases (kind, entity_id, alias_key) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS graph_aliases_key ON graph_aliases (alias_key) WHERE archived_at IS NULL;

-- External identifiers (federation licence, club system, league feed ...). The value is encrypted (it can identify a person) and
-- found through a blind index. The same (scheme, value) can point at one entity only.
CREATE TABLE IF NOT EXISTS graph_external_ids (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind               text NOT NULL CHECK (kind IN ('person','organisation','team','event','venue')),
  entity_id          uuid NOT NULL,
  scheme             text NOT NULL CHECK (scheme ~ '^[a-z0-9_]{2,40}$'),
  value_enc          text NOT NULL,
  value_idx          text NOT NULL,
  verification_state text NOT NULL DEFAULT 'claimed' CHECK (verification_state IN ('claimed','verified','rejected')),
  issuer_org_id      uuid REFERENCES organisations,
  verified_by        uuid REFERENCES users,
  verified_at        timestamptz,
  created_by         uuid NOT NULL REFERENCES users,
  created_at         timestamptz NOT NULL DEFAULT now(),
  archived_at        timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS graph_external_ids_live ON graph_external_ids (scheme, value_idx) WHERE archived_at IS NULL AND verification_state <> 'rejected';
CREATE INDEX IF NOT EXISTS graph_external_ids_entity ON graph_external_ids (kind, entity_id) WHERE archived_at IS NULL;
