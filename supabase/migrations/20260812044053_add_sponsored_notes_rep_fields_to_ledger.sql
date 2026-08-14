/*
# Add sponsored, notes, rep, and license-plate fields to cancellation ledger

1. Modified Tables
- `cancellation_ledger`
  - `sponsored` (boolean, default false) — whether the absent passenger was sponsored / didn't pay
  - `sponsor_note` (text, default '') — notes about who is paying for the sponsored person
  - `license_plate` (text, default '') — license plate of the vehicle submitted by the rep
  - `rep_name` (text, default '') — name of the transport rep who submitted (separate from submitted_by for clarity)
  - `structure_debt` (numeric, default 40) — the cancellation fee owed for this person's structure (R40 default)

2. Security
- Add UPDATE policy to cancellation_ledger (was missing — needed for editing ledger entries)
- All existing policies remain unchanged.

3. Notes
- The `submitted_by` column is kept for backward compatibility; `rep_name` is the new canonical field.
- `structure_debt` stores the fee amount per entry so it can be edited per-row in the ledger.
- These columns are added with `IF NOT EXISTS` guards so the migration is safe to re-run.
*/

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cancellation_ledger' AND column_name = 'sponsored') THEN
    ALTER TABLE cancellation_ledger ADD COLUMN sponsored boolean NOT NULL DEFAULT false;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cancellation_ledger' AND column_name = 'sponsor_note') THEN
    ALTER TABLE cancellation_ledger ADD COLUMN sponsor_note text NOT NULL DEFAULT '';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cancellation_ledger' AND column_name = 'license_plate') THEN
    ALTER TABLE cancellation_ledger ADD COLUMN license_plate text NOT NULL DEFAULT '';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cancellation_ledger' AND column_name = 'rep_name') THEN
    ALTER TABLE cancellation_ledger ADD COLUMN rep_name text NOT NULL DEFAULT '';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cancellation_ledger' AND column_name = 'structure_debt') THEN
    ALTER TABLE cancellation_ledger ADD COLUMN structure_debt numeric NOT NULL DEFAULT 40;
  END IF;
END $$;

-- Add UPDATE policy (was missing — needed for editing ledger entries)
DROP POLICY IF EXISTS "anon_update_ledger" ON cancellation_ledger;
CREATE POLICY "anon_update_ledger" ON cancellation_ledger FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

-- Add index on structure for filtering by structure debt
CREATE INDEX IF NOT EXISTS idx_cancellation_ledger_structure ON cancellation_ledger(structure);
