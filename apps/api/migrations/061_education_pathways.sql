-- Education pathways: an athlete learns a sport's rules, finds colleges/academies with programmes in it, enquires, and
-- the institution's admissions staff answer, share brochures, route to their website, broadcast to consenting enquirers,
-- introduce them to sponsors and issue certificates/badges that show on the athlete's profile.
-- An institution is an ordinary organisation (kind college / university / academy ...): it reuses organisation_members
-- for staff. Purely additive; nothing is deleted - programmes, brochures and credentials are archived / revoked, enquiries
-- are closed or withdrawn. No ON DELETE CASCADE.

-- Widen the organisation types (existing rows are untouched).
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'organisations'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%kind%' LOOP
    EXECUTE format('ALTER TABLE organisations DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE organisations ADD CONSTRAINT organisations_kind_check CHECK (kind IN ('club','academy','school','college','university','other'));

-- The public face of an institution. Listed = visible in the directory (opt-in, default off). Contacts are encrypted.
CREATE TABLE institution_profiles (
  organisation_id uuid PRIMARY KEY REFERENCES organisations,
  about           text,
  website         text CHECK (website IS NULL OR website ~ '^https://'),
  country         text,
  listed          boolean NOT NULL DEFAULT false,
  contact_email_enc text,
  contact_phone_enc text,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX institution_profiles_listed ON institution_profiles (listed) WHERE listed;

-- Rules a newcomer reads before choosing a sport. Curated by the platform team; the source is always cited.
CREATE TABLE sport_rules (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sport_id   uuid NOT NULL REFERENCES sports,
  title      text NOT NULL CHECK (length(title) BETWEEN 2 AND 120),
  body       text NOT NULL CHECK (length(body) >= 2),
  source_url text CHECK (source_url IS NULL OR source_url ~ '^https://'),
  position   int NOT NULL DEFAULT 0,
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_by uuid NOT NULL REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sport_rules_sport ON sport_rules (sport_id, status, position);

-- Courses, certificates, diplomas and degrees. sport_id is on the join table so one programme can cover several sports
-- (and a general one, e.g. sports management, can cover none).
CREATE TABLE programmes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  title           text NOT NULL CHECK (length(title) BETWEEN 2 AND 120),
  kind            text NOT NULL CHECK (kind IN ('course','certification','diploma','degree','postgraduate','short_course')),
  mode            text NOT NULL DEFAULT 'on_campus' CHECK (mode IN ('on_campus','online','hybrid')),
  description     text,
  duration_months int CHECK (duration_months IS NULL OR duration_months > 0),
  fee_minor       bigint CHECK (fee_minor IS NULL OR fee_minor >= 0),
  currency        text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  next_intake_on  date,
  apply_url       text CHECK (apply_url IS NULL OR apply_url ~ '^https://'),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_by      uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz
);
CREATE INDEX programmes_org ON programmes (organisation_id, status);
CREATE TABLE programme_sports (
  programme_id uuid NOT NULL REFERENCES programmes,
  sport_id     uuid NOT NULL REFERENCES sports,
  removed_at   timestamptz,                       -- un-ticking a sport keeps the row (soft delete)
  PRIMARY KEY (programme_id, sport_id)
);
CREATE INDEX programme_sports_sport ON programme_sports (sport_id);

-- Brochures are links to a document the institution hosts (https only).
CREATE TABLE brochures (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  programme_id    uuid REFERENCES programmes,
  title           text NOT NULL CHECK (length(title) BETWEEN 2 AND 120),
  url             text NOT NULL CHECK (url ~ '^https://'),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_by      uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX brochures_org ON brochures (organisation_id, status);

-- An athlete's enquiry to an institution (optionally about one programme). Two separate, withdrawable consents:
-- comms_consent lets the institution include them in broadcasts; sponsor_consent lets it introduce them to a sponsor.
-- Replying inside the enquiry never needs consent (the athlete started the conversation).
CREATE TABLE enquiries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  programme_id    uuid REFERENCES programmes,
  athlete_id      uuid NOT NULL REFERENCES users,
  sport_id        uuid REFERENCES sports,
  status          text NOT NULL DEFAULT 'new' CHECK (status IN ('new','in_conversation','referred','applied','admitted','enrolled','declined','withdrawn','closed')),
  comms_consent   boolean NOT NULL DEFAULT false,
  comms_consent_at timestamptz,
  sponsor_consent boolean NOT NULL DEFAULT false,
  sponsor_consent_at timestamptz,
  assigned_to     uuid REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz NOT NULL DEFAULT now(),
  staff_read_at   timestamptz,
  athlete_read_at timestamptz
);
CREATE UNIQUE INDEX enquiries_one_open ON enquiries (organisation_id, athlete_id, coalesce(programme_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE status NOT IN ('declined','withdrawn','closed','enrolled');
CREATE INDEX enquiries_org ON enquiries (organisation_id, status, last_message_at DESC);
CREATE INDEX enquiries_athlete ON enquiries (athlete_id, last_message_at DESC);

-- The thread. body is encrypted (it can hold personal details); kind marks system entries such as status changes.
CREATE TABLE enquiry_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enquiry_id  uuid NOT NULL REFERENCES enquiries,
  sender_id   uuid REFERENCES users,
  side        text NOT NULL CHECK (side IN ('athlete','institution','system')),
  kind        text NOT NULL DEFAULT 'message' CHECK (kind IN ('message','brochure','referral','status','broadcast','sponsor')),
  body_enc    text NOT NULL,
  brochure_id uuid REFERENCES brochures,
  link_url    text CHECK (link_url IS NULL OR link_url ~ '^https://'),
  broadcast_id uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX enquiry_messages_thread ON enquiry_messages (enquiry_id, created_at);

CREATE TABLE enquiry_broadcasts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id    uuid NOT NULL REFERENCES organisations,
  sent_by            uuid NOT NULL REFERENCES users,
  subject            text NOT NULL CHECK (length(subject) BETWEEN 2 AND 120),
  body               text NOT NULL CHECK (length(body) >= 2),
  programme_id       uuid REFERENCES programmes,
  sport_id           uuid REFERENCES sports,
  statuses           text[] NOT NULL DEFAULT '{}',
  recipients         int NOT NULL,
  skipped_no_consent int NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX enquiry_broadcasts_org ON enquiry_broadcasts (organisation_id, created_at DESC);

-- Introducing an enquirer to a sponsor. Needs the athlete's sponsor_consent; the sponsor then uses the normal sponsorship offer.
CREATE TABLE enquiry_sponsor_links (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enquiry_id uuid NOT NULL REFERENCES enquiries,
  sponsor_id uuid NOT NULL REFERENCES sponsors,
  note       text,
  linked_by  uuid NOT NULL REFERENCES users,
  status     text NOT NULL DEFAULT 'introduced' CHECK (status IN ('introduced','withdrawn')),
  created_at timestamptz NOT NULL DEFAULT now(),
  withdrawn_at timestamptz
);
CREATE UNIQUE INDEX enquiry_sponsor_links_once ON enquiry_sponsor_links (enquiry_id, sponsor_id) WHERE status = 'introduced';
CREATE INDEX enquiry_sponsor_links_sponsor ON enquiry_sponsor_links (sponsor_id, status);

-- Certificates and badges issued by an institution. The athlete chooses whether each shows on their profile; the code lets
-- anyone confirm it is genuine and not revoked.
CREATE TABLE credentials (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users,
  organisation_id uuid NOT NULL REFERENCES organisations,
  programme_id    uuid REFERENCES programmes,
  enquiry_id      uuid REFERENCES enquiries,
  sport_id        uuid REFERENCES sports,
  kind            text NOT NULL CHECK (kind IN ('certificate','badge','diploma','degree','course')),
  title           text NOT NULL CHECK (length(title) BETWEEN 2 AND 120),
  description     text,
  issued_on       date NOT NULL DEFAULT current_date,
  expires_on      date,
  code            text NOT NULL UNIQUE,
  status          text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','revoked')),
  revoked_at      timestamptz,
  revoke_reason   text,
  show_on_profile boolean NOT NULL DEFAULT true,
  issued_by       uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_on IS NULL OR expires_on >= issued_on)
);
CREATE INDEX credentials_user ON credentials (user_id, status);
CREATE INDEX credentials_org ON credentials (organisation_id, created_at DESC);

-- Existing passport links keep showing exactly what they showed; new links can include credentials.
ALTER TABLE passport_links ADD COLUMN IF NOT EXISTS show_credentials boolean NOT NULL DEFAULT false;
