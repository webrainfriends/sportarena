-- Role-based AI copilots (issue #598). Additive only. A run is a DRAFT built from records the caller may already read, each one fetched through the
-- owning capability (so its own ownership, consent and youth rules apply). Every proposed action is stored with its risk and stays inert until a
-- human approves it; forbidden kinds (award, medical clearance, discipline, classification, signature, transfer approval, money) are stored
-- as advisory only and can never be executed. Free text a person types is personal data, so it is stored encrypted (note_enc).
CREATE TABLE copilot_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requested_by  uuid NOT NULL REFERENCES users,
  copilot       text NOT NULL CHECK (copilot IN ('coach','athlete','event','federation','sponsor','supplier','venue','official','organisation')),
  task          text NOT NULL,
  scope_type    text,                                    -- event | body | organisation | venue | sponsorship | null
  scope_id      uuid,
  note_enc      text,
  headline      text NOT NULL,
  items         jsonb NOT NULL DEFAULT '[]',             -- [{id,severity,title,detail,why?,source_refs[]}]
  sources       jsonb NOT NULL DEFAULT '[]',             -- [{ref,capability,label,at}] every read, by reference
  limitations   jsonb NOT NULL DEFAULT '[]',
  provider      text NOT NULL DEFAULT 'rules',           -- rules | anthropic
  model         text,
  rules_version text NOT NULL,
  input_hash    text NOT NULL,
  ai            boolean NOT NULL DEFAULT false,
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','resolved','dismissed')),
  client_key    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX copilot_runs_key ON copilot_runs (requested_by, client_key) WHERE client_key IS NOT NULL;
CREATE INDEX copilot_runs_requester ON copilot_runs (requested_by, created_at DESC, id);

CREATE TABLE copilot_actions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id        uuid NOT NULL REFERENCES copilot_runs,
  item_id       text NOT NULL,
  kind          text NOT NULL,                           -- todo | create_event_task | advisory:<forbidden kind>
  label         text NOT NULL,
  capability    text,                                    -- allowlisted capability run on approval, or null
  payload       jsonb NOT NULL DEFAULT '{}',
  risk          text NOT NULL CHECK (risk IN ('low','consequential','forbidden')),
  executable    boolean NOT NULL DEFAULT false,
  status        text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','rejected','executed','failed')),
  decided_by    uuid REFERENCES users,
  decided_at    timestamptz,
  executed_at   timestamptz,
  result        jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (risk <> 'forbidden' OR executable = false)
);
CREATE INDEX copilot_actions_run ON copilot_actions (run_id, created_at, id);
