-- RFC 5545 SEQUENCE support for ICS subscription feeds.
-- version increments each time a fixture is rescheduled (time, venue or cancellation changes).
-- updated_at tracks the last modification for LAST-MODIFIED in ICS events.
-- Additive only: existing fixtures start at version 0 and updated_at = now().
ALTER TABLE fixtures ADD COLUMN IF NOT EXISTS version    int         NOT NULL DEFAULT 0;
ALTER TABLE fixtures ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
