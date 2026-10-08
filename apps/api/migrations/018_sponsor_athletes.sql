-- Sponsoring an individual: athletes opt in to sponsorship discovery (default OFF), and the existing `sponsorships` table
-- (target_type = 'athlete') carries the proposal details and the target owner's decision. No individual-specific subsystem.
CREATE TABLE sponsorship_profiles (
  user_id        uuid PRIMARY KEY REFERENCES users,
  open_to_sponsors boolean NOT NULL DEFAULT false,
  pitch          text,                                     -- what the athlete says publicly to sponsors
  looking_for    text[] NOT NULL DEFAULT '{}',             -- cash, equipment, travel, coaching, ...
  verified_sponsors_only boolean NOT NULL DEFAULT false,   -- only sponsor brands with a verified badge may send offers
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sponsorship_profiles_open ON sponsorship_profiles (open_to_sponsors) WHERE open_to_sponsors;

ALTER TABLE sponsorships
  ADD COLUMN objectives       text,
  ADD COLUMN deliverables     text,
  ADD COLUMN message          text,
  ADD COLUMN decided_at       timestamptz,
  ADD COLUMN decided_by       uuid REFERENCES users,
  ADD COLUMN decision_reason  text,
  ADD COLUMN visibility       text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private'));
ALTER TABLE sponsorships DROP CONSTRAINT sponsorships_status_check;
ALTER TABLE sponsorships ADD CONSTRAINT sponsorships_status_check CHECK (status IN ('proposed','active','declined','ended','withdrawn'));

-- Deals aimed at a person were publicly listed on the sponsor's page. A person's deal is now public only when they say so,
-- so existing ones become private (nothing is deleted; the athlete can publish a deal when accepting a future one).
UPDATE sponsorships SET visibility = 'private' WHERE target_type = 'athlete';
CREATE INDEX sponsorships_athlete ON sponsorships (target_id, status) WHERE target_type = 'athlete';
