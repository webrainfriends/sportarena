-- Offline-safe match controls (#7: offline scoring and referee app). Additive: nothing is dropped, rewritten or narrowed.
-- Kick-off, pause, resume and full time can now be taken without a signal and sent later. Each carries a client_key so a retry after a
-- lost reply cannot act twice, and the time the official really pressed the button (occurred_at, bounded by the server) so a kick-off
-- sent an hour late is not recorded as an hour late. match_events already carry client_key; this is the same guarantee for the controls.
CREATE TABLE IF NOT EXISTS fixture_control_ops (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fixture_id   uuid NOT NULL REFERENCES fixtures(id),
  client_key   text NOT NULL,
  op           text NOT NULL CHECK (op IN ('start','pause','resume','end')),
  occurred_at  timestamptz,
  recorded_at  timestamptz NOT NULL DEFAULT now(),
  recorded_by  uuid NOT NULL REFERENCES users(id),
  UNIQUE (fixture_id, client_key)
);
