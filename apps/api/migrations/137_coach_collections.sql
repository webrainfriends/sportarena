-- Coach subscriptions in the collections desk (issue #681). A coach is a fourth owner of collection cases and policies, and a late subscription
-- period (a user_plans row) a fourth kind of source. Constraints are widened only: no row is touched, nothing is dropped from user data.
ALTER TABLE collection_cases DROP CONSTRAINT IF EXISTS collection_cases_owner_type_check;
ALTER TABLE collection_cases ADD CONSTRAINT collection_cases_owner_type_check CHECK (owner_type IN ('organisation','venue','team','coach'));
ALTER TABLE collection_cases DROP CONSTRAINT IF EXISTS collection_cases_source_type_check;
ALTER TABLE collection_cases ADD CONSTRAINT collection_cases_source_type_check CHECK (source_type IN ('academy_charge','venue_plan','team_charge','coach_subscription_period'));
ALTER TABLE collection_policies DROP CONSTRAINT IF EXISTS collection_policies_owner_type_check;
ALTER TABLE collection_policies ADD CONSTRAINT collection_policies_owner_type_check CHECK (owner_type IN ('organisation','venue','team','coach'));
