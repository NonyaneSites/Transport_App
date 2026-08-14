/*
# Add general_notes column to cancellation_ledger

1. Modified Tables
- `cancellation_ledger`
  - `general_notes` (text, default '') — free-form notes from the rep submitted with attendance
    (e.g. "Person A in Taxi 1 is paying for Person B in Taxi 2"). Stored per vehicle submission
    so it appears in session stats exports and the master ledger.

2. Security
- No policy changes. Existing anon/authenticated CRUD policies already cover the new column.

3. Notes
- Idempotent: uses IF NOT EXISTS guard so it is safe to re-run.
*/

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cancellation_ledger' AND column_name = 'general_notes') THEN
    ALTER TABLE cancellation_ledger ADD COLUMN general_notes text NOT NULL DEFAULT '';
  END IF;
END $$;
