-- Two federation migrations (#525 delegation and approvals, #574 governance depth) each rewrote the fed_events subject check with only their own
-- additions. This one runs after both and allows every subject either of them writes. Additive: nothing already stored becomes invalid.
ALTER TABLE fed_events DROP CONSTRAINT IF EXISTS fed_events_subject_type_check;
ALTER TABLE fed_events ADD CONSTRAINT fed_events_subject_type_check CHECK (subject_type IN
  ('body','link','role','affiliation','licence','sanction','policy','date','delegation','approval','approval_rule','access_review','exception','campaign','jurisdiction'));
