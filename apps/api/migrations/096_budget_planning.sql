-- Budget planning (#293 follow-up): a budget carries the reasoning behind it (rationale, the earlier budget it was built from) and its
-- supporting references (approval memos, board minutes, PO / forecast links). Files are kept in the shared documents folder
-- (subject_documents) under subject_type 'budget', so there is one upload path for the whole app. Purely additive: new nullable
-- columns, a new table and two widened CHECK constraints; no existing row is touched, nothing is dropped, rewritten or deleted.
ALTER TABLE sponsorship_budgets ADD COLUMN IF NOT EXISTS notes text CHECK (notes IS NULL OR length(notes) <= 2000);
ALTER TABLE sponsorship_budgets ADD COLUMN IF NOT EXISTS basis_budget_id uuid REFERENCES sponsorship_budgets;

CREATE TABLE IF NOT EXISTS sponsorship_budget_references (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  budget_id  uuid NOT NULL REFERENCES sponsorship_budgets,
  kind       text NOT NULL CHECK (kind IN ('approval','board_minutes','forecast','purchase_order','contract','policy','other')),
  title      text NOT NULL CHECK (length(title) BETWEEN 2 AND 160),
  url        text CHECK (url IS NULL OR url ~ '^https://'),
  ref_no     text CHECK (ref_no IS NULL OR length(ref_no) <= 80),
  created_by uuid NOT NULL REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,                                    -- hidden, never deleted
  CHECK (url IS NOT NULL OR ref_no IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS sponsorship_budget_references_budget ON sponsorship_budget_references (budget_id, created_at DESC) WHERE removed_at IS NULL;

ALTER TABLE subject_documents DROP CONSTRAINT IF EXISTS subject_documents_subject_type_check;
ALTER TABLE subject_documents ADD CONSTRAINT subject_documents_subject_type_check CHECK (subject_type IN ('team','event','venue','budget'));
ALTER TABLE subject_documents DROP CONSTRAINT IF EXISTS subject_documents_kind_check;
ALTER TABLE subject_documents ADD CONSTRAINT subject_documents_kind_check CHECK (kind IN ('policy','certificate','receipt','quote','other','contract','approval','forecast','invoice','report'));
