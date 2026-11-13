-- Migration 208: Drill library media steps. Additive only.
-- Adds `steps` to coach_templates and a drill_media table for uploaded photos/videos.
-- steps schema: [{type:'text'|'photo'|'video', media_id?:uuid, text?:str, caption?:str}]
-- Rows are retired with removed_at — files are never deleted.

ALTER TABLE coach_templates
  ADD COLUMN steps jsonb NOT NULL DEFAULT '[]';

CREATE TABLE drill_media (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id   uuid NOT NULL REFERENCES coach_templates ON DELETE RESTRICT,
  uploaded_by   uuid NOT NULL REFERENCES users,
  kind          text NOT NULL CHECK (kind IN ('photo','video')),
  content_type  text NOT NULL,
  file_name     text NOT NULL,
  size_bytes    bigint NOT NULL,
  sha256        text NOT NULL,
  original_name text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  removed_at    timestamptz
);

CREATE INDEX drill_media_template ON drill_media (template_id) WHERE removed_at IS NULL;

CREATE OR REPLACE RULE drill_media_no_delete
  AS ON DELETE TO drill_media DO INSTEAD NOTHING;
