-- Timestamped video annotations (#318): encrypted text + drawing, replies, resolve. Additive only.
BEGIN;

CREATE TABLE IF NOT EXISTS video_annotations (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id         uuid        NOT NULL REFERENCES passport_videos(id),
  author_id        uuid        NOT NULL REFERENCES users(id),
  timestamp_ms     int         NOT NULL CHECK (timestamp_ms >= 0),
  text_enc         text,
  drawing_data_enc text,
  resolved_at      timestamptz,
  archived_at      timestamptz,
  row_version      int         NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS video_annotations_video_id_idx   ON video_annotations(video_id);
CREATE INDEX IF NOT EXISTS video_annotations_author_id_idx  ON video_annotations(author_id);
CREATE INDEX IF NOT EXISTS video_annotations_ts_idx         ON video_annotations(video_id, timestamp_ms) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS video_annotation_replies (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  annotation_id  uuid        NOT NULL REFERENCES video_annotations(id),
  author_id      uuid        NOT NULL REFERENCES users(id),
  text_enc       text        NOT NULL,
  archived_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS video_annotation_replies_ann_idx ON video_annotation_replies(annotation_id);

COMMIT;
