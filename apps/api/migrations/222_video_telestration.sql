-- Issue #565: Telestration frames and shapes — lines, arrows, zones, markers, freeze-frame.

-- A telestration frame: one annotated still from a video
CREATE TABLE IF NOT EXISTS video_telestration_frames (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id uuid NOT NULL REFERENCES passport_videos,
  timestamp_ms bigint NOT NULL,
  freeze_frame boolean NOT NULL DEFAULT true,
  title text,
  created_by uuid NOT NULL REFERENCES users,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vtf_video ON video_telestration_frames (video_id) WHERE archived_at IS NULL;

-- Individual shapes drawn on a frame
CREATE TABLE IF NOT EXISTS video_telestration_shapes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  frame_id uuid NOT NULL REFERENCES video_telestration_frames,
  layer int NOT NULL DEFAULT 0,
  shape_type text NOT NULL CHECK (shape_type IN ('line','arrow','zone','marker','text','highlight')),
  coords_enc text NOT NULL,          -- JSON array of {x,y} points, encrypted at rest
  colour text NOT NULL DEFAULT '#FF4444',
  label text,                        -- optional text label
  font_size int,                     -- for text shapes
  stroke_width int NOT NULL DEFAULT 3,
  opacity numeric(3,2) NOT NULL DEFAULT 1.0,
  author_id uuid NOT NULL REFERENCES users,
  removed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vts_frame ON video_telestration_shapes (frame_id) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS vts_frame_layer ON video_telestration_shapes (frame_id, layer) WHERE removed_at IS NULL;
