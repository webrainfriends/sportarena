-- Planning tasks move onto the department boards. A card remembers which old task it came from, so importing the checklist is safe to repeat
-- and the original event_tasks rows stay untouched. Additive.
ALTER TABLE event_cards ADD COLUMN IF NOT EXISTS legacy_task_id uuid REFERENCES event_tasks;
CREATE UNIQUE INDEX IF NOT EXISTS event_cards_legacy_task ON event_cards (legacy_task_id) WHERE legacy_task_id IS NOT NULL;
