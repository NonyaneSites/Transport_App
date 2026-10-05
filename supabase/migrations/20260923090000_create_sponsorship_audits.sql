/*
# Create sponsorship_audits & reported_sponsorships table for reported sponsorships audit

1. New Tables / Views
- `sponsorship_audits`
  - `id` (text, primary key) — e.g. "sp_2026-08-23_tshepomaseko"
  - `manifest_key` (text NOT NULL DEFAULT '')
  - `date` (text NOT NULL DEFAULT '') — What date
  - `service` (text NOT NULL DEFAULT '') — What service
  - `passenger_id` (text DEFAULT '')
  - `passenger_name` (text NOT NULL) — Names of people claiming sponsorship
  - `structure` (text NOT NULL DEFAULT '') — Structure code (e.g. S1, S2, Z1)
  - `stop` (text NOT NULL DEFAULT '') — Pick-up / drop-off stop
  - `vehicle_name` (text NOT NULL DEFAULT '') — Vehicle they are travelling in
  - `rep_name` (text NOT NULL DEFAULT '') — Reporting Transport Rep
  - `sponsor_note` (text NOT NULL DEFAULT '') — Details on who is paying
  - `status` (text NOT NULL DEFAULT 'pending') — 'pending', 'actually_sponsored' (approved), 'unpaid_sponsorship' / 'unaccounted_sponsorship' (denied)
  - `status_updated_at` (timestamptz)
  - `ledger_entry_id` (text DEFAULT '')
  - `submitted_at` (timestamptz NOT NULL DEFAULT now())

- `reported_sponsorships` (view alias pointing directly to `sponsorship_audits`)

2. Security
- Enable RLS on `sponsorship_audits`.
- Allow anon + authenticated CRUD (SELECT, INSERT, UPDATE, DELETE).
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

-- Indexes for lightning fast lookups
CREATE INDEX IF NOT EXISTS idx_sponsorship_audits_date ON sponsorship_audits(date);
CREATE INDEX IF NOT EXISTS idx_sponsorship_audits_manifest_key ON sponsorship_audits(manifest_key);
CREATE INDEX IF NOT EXISTS idx_sponsorship_audits_status ON sponsorship_audits(status);
CREATE INDEX IF NOT EXISTS idx_sponsorship_audits_structure ON sponsorship_audits(structure);
CREATE INDEX IF NOT EXISTS idx_sponsorship_audits_vehicle ON sponsorship_audits(vehicle_name);
CREATE INDEX IF NOT EXISTS idx_sponsorship_audits_passenger ON sponsorship_audits(passenger_name);

-- Alias view so either reported_sponsorships or sponsorship_audits works seamlessly
CREATE OR REPLACE VIEW reported_sponsorships AS
  SELECT * FROM sponsorship_audits;

