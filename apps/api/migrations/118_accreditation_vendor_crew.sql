-- Vendor crews for accreditation (#481): an accepted vendor or sponsor nominates its own people. The crew is a small roster owned by the existing
-- event_vendors record (no second staff identity); a crew member counts as that vendor's engagement for eligibility. Additive only; a person taken
-- off the crew is kept with removed_at.
CREATE TABLE event_vendor_crew (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id  uuid NOT NULL REFERENCES event_vendors,
  event_id   uuid NOT NULL REFERENCES events,
  user_id    uuid NOT NULL REFERENCES users,
  added_by   uuid NOT NULL REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz
);
CREATE UNIQUE INDEX event_vendor_crew_open ON event_vendor_crew (vendor_id, user_id) WHERE removed_at IS NULL;
CREATE INDEX event_vendor_crew_user ON event_vendor_crew (user_id, event_id) WHERE removed_at IS NULL;
ALTER TABLE accreditations ADD COLUMN vendor_id uuid REFERENCES event_vendors;
CREATE INDEX accreditations_vendor ON accreditations (vendor_id) WHERE vendor_id IS NOT NULL;
