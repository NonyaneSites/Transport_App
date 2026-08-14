/*
# Create cancellation_ledger table (single-tenant, no auth)

1. New Tables
- `cancellation_ledger`
  - `id` (uuid, primary key)
  - `manifest_key` (text) — the session key like `2025-09-07_PM_Normal`
  - `date` (text) — the service date in YYYY-MM-DD format
  - `service` (text) — the service type label
  - `passenger_name` (text) — full name of the absent passenger
  - `stop` (text) — the pickup stop
  - `structure` (text) — the church structure (e.g. S3, S7)
  - `vehicle_name` (text) — name of the vehicle they were assigned to
  - `submitted_by` (text) — optional name of the rep who submitted
  - `submitted_at` (timestamptz, default now())

2. Security
- Enable RLS on `cancellation_ledger`.
- Allow anon + authenticated CRUD because the app is intentionally shared/public
  (transport coordination portal with no sign-in screen).
*/

CREATE TABLE IF NOT EXISTS cancellation_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  manifest_key text NOT NULL,
  date text NOT NULL,
  service text NOT NULL,
  passenger_name text NOT NULL,
  stop text NOT NULL DEFAULT 'Unknown',
  structure text NOT NULL DEFAULT '',
  vehicle_name text NOT NULL DEFAULT '',
  submitted_by text NOT NULL DEFAULT '',
  submitted_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE cancellation_ledger ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_ledger" ON cancellation_ledger;
CREATE POLICY "anon_select_ledger" ON cancellation_ledger FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_ledger" ON cancellation_ledger;
CREATE POLICY "anon_insert_ledger" ON cancellation_ledger FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_ledger" ON cancellation_ledger;
CREATE POLICY "anon_delete_ledger" ON cancellation_ledger FOR DELETE
  TO anon, authenticated USING (true);

CREATE INDEX IF NOT EXISTS idx_cancellation_ledger_date ON cancellation_ledger(date);
CREATE INDEX IF NOT EXISTS idx_cancellation_ledger_manifest_key ON cancellation_ledger(manifest_key);
