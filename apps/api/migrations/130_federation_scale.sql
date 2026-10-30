-- Federation governance at scale (#525). Additive only: new tables and columns; nothing is dropped, rewritten or narrowed.
-- Builds on the Federation & Governing Body OS (#475/#477): same hierarchy (governing_body_links), same roles, same policies, same history.

-- ---- delegated administration: an explicit, scoped, expiring, revocable grant of ONE role on a node, reaching a bounded number of levels below it.
-- It never reaches siblings, ancestors or the platform, and it cannot be re-delegated (only a body's owner/admin grants).
CREATE TABLE fed_delegations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  body_id       uuid NOT NULL REFERENCES governing_bodies,
  user_id       uuid NOT NULL REFERENCES users,
  role          text NOT NULL CHECK (role IN ('registrar','licensing','sanctioner','secretary','compliance','auditor','integrity')),
  sport_id      uuid REFERENCES sports,
  max_depth     integer NOT NULL DEFAULT 1 CHECK (max_depth BETWEEN 0 AND 8),   -- 0 = this node only, 1 = its direct children as well, ...
  expires_on    date,
  reason        text NOT NULL CHECK (length(reason) BETWEEN 5 AND 500),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  granted_by    uuid NOT NULL REFERENCES users,
  granted_at    timestamptz NOT NULL DEFAULT now(),
  revoked_by    uuid REFERENCES users,
  revoked_at    timestamptz,
  revoke_reason text CHECK (revoke_reason IS NULL OR length(revoke_reason) <= 500)
);
CREATE UNIQUE INDEX fed_delegations_live ON fed_delegations (body_id, user_id, role, coalesce(sport_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE status = 'active';
CREATE INDEX fed_delegations_user ON fed_delegations (user_id) WHERE status = 'active';
CREATE INDEX fed_delegations_body ON fed_delegations (body_id, status);

-- ---- policy inheritance: a parent can lock a requirement so no node below it may publish its own version of that kind/sport.
ALTER TABLE fed_policies ADD COLUMN IF NOT EXISTS local_override text NOT NULL DEFAULT 'allowed';
ALTER TABLE fed_policies ADD CONSTRAINT fed_policies_local_override_check CHECK (local_override IN ('allowed','locked'));

-- ---- maker-checker (four eyes). Rules are appended, never edited: the latest row per (body, action) is the rule in force.
CREATE TABLE fed_approval_rules (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  body_id   uuid NOT NULL REFERENCES governing_bodies,
  action    text NOT NULL CHECK (action IN ('affiliation_approve','affiliation_suspend','eligibility_override','credential_exception','sanction_approve','policy_publish','bulk_export')),
  required  boolean NOT NULL,
  reason    text CHECK (reason IS NULL OR length(reason) <= 500),
  set_by    uuid NOT NULL REFERENCES users,
  set_at    timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX fed_approval_rules_latest ON fed_approval_rules (body_id, action, set_at DESC);

CREATE TABLE fed_approvals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  body_id       uuid NOT NULL REFERENCES governing_bodies,
  action        text NOT NULL CHECK (action IN ('affiliation_approve','affiliation_suspend','eligibility_override','credential_exception','sanction_approve','policy_publish','bulk_export')),
  subject_type  text NOT NULL CHECK (subject_type IN ('affiliation','licence','sanction','policy','report')),
  subject_id    uuid NOT NULL,
  payload_hash  text NOT NULL,                                   -- the approval covers exactly this request, nothing else
  summary       text NOT NULL CHECK (length(summary) BETWEEN 5 AND 500),
  evidence      text[] NOT NULL DEFAULT '{}',                    -- references only (record ids or https links), never content
  rule_body_id  uuid NOT NULL REFERENCES governing_bodies,       -- which node's rule required the second pair of eyes
  policy_version_id uuid REFERENCES fed_policy_versions,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  requested_by  uuid NOT NULL REFERENCES users,
  requested_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at    timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  decided_by    uuid REFERENCES users,
  decided_at    timestamptz,
  decision_reason text CHECK (decision_reason IS NULL OR length(decision_reason) <= 500),
  authority_source text,                                         -- how the decider was entitled: admin | role | delegation | ancestor
  effective_from date,
  consumed_at   timestamptz,
  consumed_by   uuid REFERENCES users,
  CHECK (decided_by IS NULL OR decided_by <> requested_by)      -- backstop: nobody approves their own request
);
CREATE INDEX fed_approvals_body ON fed_approvals (body_id, status, requested_at DESC);
CREATE INDEX fed_approvals_subject ON fed_approvals (subject_type, subject_id);

-- A request is decided once, and used once. Everything else is frozen; rows are never deleted.
CREATE FUNCTION fed_approvals_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'approvals are never deleted'; END IF;
  IF (NEW.id, NEW.body_id, NEW.action, NEW.subject_type, NEW.subject_id, NEW.payload_hash, NEW.summary, NEW.evidence, NEW.rule_body_id, NEW.requested_by, NEW.requested_at, NEW.expires_at)
     IS DISTINCT FROM (OLD.id, OLD.body_id, OLD.action, OLD.subject_type, OLD.subject_id, OLD.payload_hash, OLD.summary, OLD.evidence, OLD.rule_body_id, OLD.requested_by, OLD.requested_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'an approval request cannot be changed';
  END IF;
  IF OLD.status <> 'pending' AND (NEW.status, NEW.decided_by, NEW.decided_at, NEW.decision_reason, NEW.authority_source) IS DISTINCT FROM (OLD.status, OLD.decided_by, OLD.decided_at, OLD.decision_reason, OLD.authority_source) THEN
    RAISE EXCEPTION 'a decided approval is immutable';
  END IF;
  IF OLD.consumed_at IS NOT NULL AND (NEW.consumed_at, NEW.consumed_by) IS DISTINCT FROM (OLD.consumed_at, OLD.consumed_by) THEN
    RAISE EXCEPTION 'an approval is used once';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fed_approvals_guard BEFORE UPDATE OR DELETE ON fed_approvals FOR EACH ROW EXECUTE FUNCTION fed_approvals_guard();
CREATE TRIGGER fed_approval_rules_append_only BEFORE UPDATE OR DELETE ON fed_approval_rules FOR EACH ROW EXECUTE FUNCTION fed_events_append_only();

-- ---- periodic access review: a certified snapshot per node. Items record what the reviewer decided about each grant; revocations keep history.
CREATE TABLE fed_access_reviews (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  body_id     uuid NOT NULL REFERENCES governing_bodies,
  reviewer_id uuid NOT NULL REFERENCES users,
  scope_note  text CHECK (scope_note IS NULL OR length(scope_note) <= 500),
  nodes       integer NOT NULL,
  kept        integer NOT NULL DEFAULT 0,
  revoked     integer NOT NULL DEFAULT 0,
  flagged     integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX fed_access_reviews_body ON fed_access_reviews (body_id, created_at DESC);
CREATE TABLE fed_access_review_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id   uuid NOT NULL REFERENCES fed_access_reviews,
  body_id     uuid NOT NULL REFERENCES governing_bodies,
  kind        text NOT NULL CHECK (kind IN ('role','delegation','org_admin')),
  ref_id      uuid NOT NULL,                                    -- governing_body_roles.id | fed_delegations.id | organisation_members.id
  user_id     uuid NOT NULL REFERENCES users,
  decision    text NOT NULL CHECK (decision IN ('keep','revoke','flag')),
  reason      text CHECK (reason IS NULL OR length(reason) <= 500),
  UNIQUE (review_id, kind, ref_id)
);
CREATE TRIGGER fed_access_review_items_append_only BEFORE UPDATE OR DELETE ON fed_access_review_items FOR EACH ROW EXECUTE FUNCTION fed_events_append_only();

-- ---- the immutable history learns the new subjects
ALTER TABLE fed_events DROP CONSTRAINT IF EXISTS fed_events_subject_type_check;
ALTER TABLE fed_events ADD CONSTRAINT fed_events_subject_type_check CHECK (subject_type IN ('body','link','role','affiliation','licence','sanction','policy','date','delegation','approval','approval_rule','access_review'));

-- ---- exports: the purpose and (when four eyes applied) the approval that allowed it, kept with the log row
ALTER TABLE fed_exports ADD COLUMN IF NOT EXISTS purpose text;
ALTER TABLE fed_exports ADD COLUMN IF NOT EXISTS approval_id uuid REFERENCES fed_approvals;
ALTER TABLE fed_exports ADD COLUMN IF NOT EXISTS redactions jsonb NOT NULL DEFAULT '{}';
