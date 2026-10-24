-- A follow-up of kind book_session can point at the next trial (second round) so the player can book it from their card. Additive.
ALTER TABLE trial_follow_ups ADD COLUMN next_event_id uuid REFERENCES events;
