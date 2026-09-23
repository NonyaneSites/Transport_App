/*
# Create sponsorship_audits table (single-tenant, no auth)

1. New Tables
- `sponsorship_audits`
  - `id` (text, primary key) — e.g. "sp_2026-08-23_tshepomaseko"
  - `manifest_key` (text NOT NULL DEFAULT '')
  - `date` (text NOT NULL DEFAULT '')
  - `service` (text NOT NULL DEFAULT '')
  - `passenger_id` (text DEFAULT '')
  - `passenger_name` (text NOT NULL)
  - `structure` (text NOT NULL DEFAULT '')
  - `stop` (text NOT NULL DEFAULT '')
  - `vehicle_name` (text NOT NULL DEFAULT '')
  - `rep_name` (text NOT NULL DEFAULT '')
  - `sponsor_note` (text NOT NULL DEFAULT '')
  - `status` (text NOT NULL DEFAULT 'pending')
  - `status_updated_at` (timestamptz)
  - `ledger_entry_id` (text DEFAULT '')
  - `submitted_at` (timestamptz NOT NULL DEFAULT now())

2. Security
- Enable RLS on `sponsorship_audits`.
- Allow anon + authenticated CRUD (SELECT, INSERT, UPDATE, DELETE) matching other tables.
*/

CREATE TABLE IF NOT EXISTS sponsorship_audits (
  id text PRIMARY KEY,
  manifest_key text NOT NULL DEFAULT '',
  date text NOT NULL DEFAULT '',
  service text NOT NULL DEFAULT '',
  passenger_id text DEFAULT '',
  passenger_name text NOT NULL,
  structure text NOT NULL DEFAULT '',
  stop text NOT NULL DEFAULT '',
  vehicle_name text NOT NULL DEFAULT '',
  rep_name text NOT NULL DEFAULT '',
  sponsor_note text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending',
  status_updated_at timestamptz,
  ledger_entry_id text DEFAULT '',
  submitted_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE sponsorship_audits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_sponsorships" ON sponsorship_audits;
CREATE POLICY "anon_select_sponsorships" ON sponsorship_audits FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_sponsorships" ON sponsorship_audits;
CREATE POLICY "anon_insert_sponsorships" ON sponsorship_audits FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_sponsorships" ON sponsorship_audits;
CREATE POLICY "anon_update_sponsorships" ON sponsorship_audits FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_sponsorships" ON sponsorship_audits;
CREATE POLICY "anon_delete_sponsorships" ON sponsorship_audits FOR DELETE
  TO anon, authenticated USING (true);

CREATE INDEX IF NOT EXISTS idx_sponsorship_audits_date ON sponsorship_audits(date);
CREATE INDEX IF NOT EXISTS idx_sponsorship_audits_manifest_key ON sponsorship_audits(manifest_key);
CREATE INDEX IF NOT EXISTS idx_sponsorship_audits_status ON sponsorship_audits(status);
