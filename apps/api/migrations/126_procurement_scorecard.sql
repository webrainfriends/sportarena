-- Sports procurement lifecycle depth (#591). Additive only: two nullable/defaulted columns and one widened CHECK. Nothing is dropped, narrowed or rewritten.
-- Demand can be raised for a competition (a competition is an events row, as games.competition_id already does) and can name the credential kinds
-- a supplier must hold; both are frozen into the RFQ scope snapshot when it is issued, so every bidder is held to the same version.
ALTER TABLE svc_requirements ADD COLUMN IF NOT EXISTS competition_id uuid REFERENCES events;
ALTER TABLE svc_requirements ADD COLUMN IF NOT EXISTS compliance_kinds text[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS svc_requirements_competition ON svc_requirements (competition_id) WHERE competition_id IS NOT NULL;
-- A buyer or supplier can open a dispute about a service order through the existing case desk (no second dispute store).
ALTER TABLE case_links DROP CONSTRAINT IF EXISTS case_links_entity_type_check;
ALTER TABLE case_links ADD CONSTRAINT case_links_entity_type_check CHECK (entity_type IN ('reservation','booking','invoice','payment','shop_order','coach_hire','event','game','fixture','appointment','insurance_policy','sponsorship',
  'sponsorship_obligation','sponsorship_payment','sponsorship_delivery','sponsorship_submission','billboard_post','federation_licence','federation_affiliation','federation_sanction','service_order'));
