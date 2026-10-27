-- Supplier services (#458) follow-up: durable, bounded report exports (CSV / XLSX / PDF) built by the worker and stored encrypted.
-- Additive only. Mirrors the tender-zone export pattern; a file is readable only by the person who requested it, and only while they are still authorised.
CREATE TABLE IF NOT EXISTS svc_exports (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users,
  side         text NOT NULL CHECK (side IN ('supplier','buyer')),
  scope_id     uuid NOT NULL,                                        -- the supplier profile or procurement context
  report       text NOT NULL CHECK (report IN ('orders','invoices','payments','tax','dashboard')),
  format       text NOT NULL CHECK (format IN ('csv','xlsx','pdf')),
  params       jsonb NOT NULL DEFAULT '{}',
  status       text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','ready','failed')),
  name         text,
  mime         text,
  stored       text,
  size_bytes   int,
  sha256       text,
  row_count    int,
  truncated    boolean NOT NULL DEFAULT false,
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS svc_exports_user ON svc_exports (user_id, created_at DESC);
