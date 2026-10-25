-- Sponsor calls and sponsorship requests (issue #67): an accepted Billboard application is linked to the canonical sponsorship offer
-- made from it, instead of a second funding model. Additive: one nullable column, one widened CHECK, one partial unique index.
-- Rollback: stop sending billboard_response_id; nothing else depends on the column.
ALTER TABLE sponsorships ADD COLUMN IF NOT EXISTS billboard_response_id uuid REFERENCES billboard_responses;
CREATE UNIQUE INDEX IF NOT EXISTS sponsorships_billboard_response ON sponsorships (billboard_response_id) WHERE billboard_response_id IS NOT NULL;
ALTER TABLE billboard_responses DROP CONSTRAINT IF EXISTS billboard_responses_engagement_type_check;
ALTER TABLE billboard_responses ADD CONSTRAINT billboard_responses_engagement_type_check CHECK (engagement_type IS NULL OR engagement_type IN ('team_member','association','sponsorship'));
