-- A program can draw on several budgets and a budget can fund several programs (a budget covers any subset of spending). Additive:
-- one link table (unlinking only sets unlinked_at, nothing is deleted) and a nullable budget on each award. sponsorship_programs.budget_id
-- stays and now means the program's DEFAULT budget for new awards. Existing links are backfilled from it; existing awards keep the budget
-- their program had. Reservations and agreements already carry their own budget_id, so no money moves and no balance changes.
CREATE TABLE IF NOT EXISTS sponsorship_program_budgets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id  uuid NOT NULL REFERENCES sponsorship_programs,
  budget_id   uuid NOT NULL REFERENCES sponsorship_budgets,
  created_by  uuid REFERENCES users,
  created_at  timestamptz NOT NULL DEFAULT now(),
  unlinked_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS sponsorship_program_budgets_live ON sponsorship_program_budgets (program_id, budget_id) WHERE unlinked_at IS NULL;
CREATE INDEX IF NOT EXISTS sponsorship_program_budgets_budget ON sponsorship_program_budgets (budget_id) WHERE unlinked_at IS NULL;

INSERT INTO sponsorship_program_budgets(program_id, budget_id, created_by, created_at)
  SELECT p.id, p.budget_id, p.created_by, now() FROM sponsorship_programs p
   WHERE p.budget_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM sponsorship_program_budgets l WHERE l.program_id=p.id AND l.budget_id=p.budget_id AND l.unlinked_at IS NULL);

ALTER TABLE sponsorship_awards ADD COLUMN IF NOT EXISTS budget_id uuid REFERENCES sponsorship_budgets;
UPDATE sponsorship_awards a SET budget_id = coalesce((SELECT r.budget_id FROM sponsorship_award_reservations r WHERE r.award_id=a.id), p.budget_id)
  FROM sponsorship_programs p WHERE p.id=a.program_id AND a.budget_id IS NULL;
CREATE INDEX IF NOT EXISTS sponsorship_awards_budget ON sponsorship_awards (budget_id) WHERE budget_id IS NOT NULL;
