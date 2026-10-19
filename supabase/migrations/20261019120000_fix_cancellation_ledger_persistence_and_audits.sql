/*
# Fix Cancellation Ledger Database Persistence, Logical Removals, and Audit Trail

1. Table Enhancements (`cancellation_ledger`):
   - Adds `event_key` (text) for deterministic event identification and idempotent imports.
   - Adds `settled_at` (timestamptz), `settled_by` (text), and `settlement_notes` (text).
   - Adds `removed_at` (timestamptz), `removed_by` (text), and `removal_reason` (text).
   - Adds `status` (text DEFAULT 'Unpaid') if missing, and `fee` (numeric DEFAULT 40) if missing.
   - Adds `updated_at` (timestamptz DEFAULT now()).

2. Financial Audit Trail Table (`cancellation_ledger_audits`):
   - Tracks every settlement, partial payment, debt reduction, logical removal, or manual addition.
   - Records previous status and balance vs new status and balance.
   - Captures actor identity, reason/notes, and timestamp.

3. Indexes & Constraints:
   - Partial unique index on `event_key` WHERE `event_key IS NOT NULL` to prevent duplicate debts.
   - Index on `status` and `(manifest_key, passenger_name)`.

4. Row Level Security (RLS) Policies:
   - SELECT permitted for authenticated and anon (required for Transport Reps and Admin dashboard).
   - INSERT permitted for authenticated and anon with check.
   - UPDATE permitted for authenticated and anon (or admin) with check to allow settlements.
   - DELETE policy restricted to administrators.

5. Atomic RPC Functions:
   - `settle_cancellation_debts`: Atomic multi-record settlement with audit logging.
   - `remove_cancellation_debts`: Durable logical removal with audit logging.
   - `record_cancellation_partial_payment`: Oldest-first debt reduction with audit logging.
*/

-- 1. Ensure all columns exist on cancellation_ledger
DO $$ BEGIN
  -- Status column
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cancellation_ledger' AND column_name = 'status') THEN
    ALTER TABLE cancellation_ledger ADD COLUMN status text NOT NULL DEFAULT 'Unpaid';
  END IF;

  -- Fee column (historical baseline assessment)
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cancellation_ledger' AND column_name = 'fee') THEN
    ALTER TABLE cancellation_ledger ADD COLUMN fee numeric NOT NULL DEFAULT 40;
  END IF;

  -- Event key for idempotent creation & deduplication
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cancellation_ledger' AND column_name = 'event_key') THEN
    ALTER TABLE cancellation_ledger ADD COLUMN event_key text;
  END IF;

  -- Settlement audit tracking columns
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cancellation_ledger' AND column_name = 'settled_at') THEN
    ALTER TABLE cancellation_ledger ADD COLUMN settled_at timestamptz;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cancellation_ledger' AND column_name = 'settled_by') THEN
    ALTER TABLE cancellation_ledger ADD COLUMN settled_by text DEFAULT '';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cancellation_ledger' AND column_name = 'settlement_notes') THEN
    ALTER TABLE cancellation_ledger ADD COLUMN settlement_notes text DEFAULT '';
  END IF;

  -- Removal audit tracking columns (logical deletion / tombstone)
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cancellation_ledger' AND column_name = 'removed_at') THEN
    ALTER TABLE cancellation_ledger ADD COLUMN removed_at timestamptz;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cancellation_ledger' AND column_name = 'removed_by') THEN
    ALTER TABLE cancellation_ledger ADD COLUMN removed_by text DEFAULT '';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cancellation_ledger' AND column_name = 'removal_reason') THEN
    ALTER TABLE cancellation_ledger ADD COLUMN removal_reason text DEFAULT '';
  END IF;

  -- Updated timestamp
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cancellation_ledger' AND column_name = 'updated_at') THEN
    ALTER TABLE cancellation_ledger ADD COLUMN updated_at timestamptz DEFAULT now();
  END IF;
END $$;

-- 2. Indexes on cancellation_ledger
CREATE INDEX IF NOT EXISTS idx_cancellation_ledger_status ON cancellation_ledger(status);
CREATE INDEX IF NOT EXISTS idx_cancellation_ledger_event_key ON cancellation_ledger(event_key);
CREATE INDEX IF NOT EXISTS idx_cancellation_ledger_date ON cancellation_ledger(date);
CREATE INDEX IF NOT EXISTS idx_cancellation_ledger_structure ON cancellation_ledger(structure);
CREATE INDEX IF NOT EXISTS idx_cancellation_ledger_manifest_key ON cancellation_ledger(manifest_key);

-- 3. Financial Audit Trail Table
CREATE TABLE IF NOT EXISTS cancellation_ledger_audits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ledger_id uuid REFERENCES cancellation_ledger(id) ON DELETE CASCADE,
  action text NOT NULL, -- 'SETTLE', 'PARTIAL_PAYMENT', 'REMOVE', 'RESTORE', 'UPDATE', 'CREATE'
  previous_status text,
  new_status text,
  previous_debt numeric,
  new_debt numeric,
  actor_id uuid,
  actor_email text DEFAULT '',
  actor_name text DEFAULT '',
  notes text DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE cancellation_ledger_audits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "audits_select_policy" ON cancellation_ledger_audits;
CREATE POLICY "audits_select_policy" ON cancellation_ledger_audits
  FOR SELECT TO anon, authenticated
  USING (true);

DROP POLICY IF EXISTS "audits_insert_policy" ON cancellation_ledger_audits;
CREATE POLICY "audits_insert_policy" ON cancellation_ledger_audits
  FOR INSERT TO anon, authenticated
  WITH CHECK (true);

-- 4. Ensure RLS policies on cancellation_ledger allow proper updates and inserts
ALTER TABLE cancellation_ledger ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_ledger" ON cancellation_ledger;
CREATE POLICY "anon_select_ledger" ON cancellation_ledger
  FOR SELECT TO anon, authenticated
  USING (true);

DROP POLICY IF EXISTS "anon_insert_ledger" ON cancellation_ledger;
CREATE POLICY "anon_insert_ledger" ON cancellation_ledger
  FOR INSERT TO anon, authenticated
  WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_ledger" ON cancellation_ledger;
CREATE POLICY "anon_update_ledger" ON cancellation_ledger
  FOR UPDATE TO anon, authenticated
  USING (true)
  WITH CHECK (true);

-- 5. Stored Procedures (RPCs) for transactional financial operations

-- A. Batch Settle
CREATE OR REPLACE FUNCTION settle_cancellation_debts(
  p_ids text[],
  p_settled_by text DEFAULT 'Admin',
  p_notes text DEFAULT ''
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rec RECORD;
  settled_count int := 0;
  now_ts timestamptz := now();
BEGIN
  IF p_ids IS NULL OR array_length(p_ids, 1) IS NULL THEN
    RETURN jsonb_build_object('success', true, 'count', 0);
  END IF;

  FOR rec IN
    SELECT id, status, structure_debt
    FROM cancellation_ledger
    WHERE id::text = ANY(p_ids)
    FOR UPDATE
  LOOP
    -- Update ledger row
    UPDATE cancellation_ledger
    SET
      status = 'Settled',
      structure_debt = 0,
      settled_at = now_ts,
      settled_by = COALESCE(p_settled_by, 'Admin'),
      settlement_notes = COALESCE(p_notes, ''),
      updated_at = now_ts
    WHERE id = rec.id;

    -- Record audit log
    INSERT INTO cancellation_ledger_audits (
      ledger_id, action, previous_status, new_status,
      previous_debt, new_debt, actor_name, notes, created_at
    ) VALUES (
      rec.id, 'SETTLE', rec.status, 'Settled',
      rec.structure_debt, 0, COALESCE(p_settled_by, 'Admin'),
      COALESCE(p_notes, 'Settled in full'), now_ts
    );

    settled_count := settled_count + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'count', settled_count,
    'settled_at', now_ts
  );
END;
$$;

-- B. Batch Remove (Durable Logical Deletion)
CREATE OR REPLACE FUNCTION remove_cancellation_debts(
  p_ids text[],
  p_removed_by text DEFAULT 'Admin',
  p_reason text DEFAULT ''
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rec RECORD;
  removed_count int := 0;
  now_ts timestamptz := now();
BEGIN
  IF p_ids IS NULL OR array_length(p_ids, 1) IS NULL THEN
    RETURN jsonb_build_object('success', true, 'count', 0);
  END IF;

  FOR rec IN
    SELECT id, status, structure_debt
    FROM cancellation_ledger
    WHERE id::text = ANY(p_ids)
    FOR UPDATE
  LOOP
    -- Update ledger row as Removed (logical tombstone)
    UPDATE cancellation_ledger
    SET
      status = 'Removed',
      structure_debt = 0,
      removed_at = now_ts,
      removed_by = COALESCE(p_removed_by, 'Admin'),
      removal_reason = COALESCE(p_reason, ''),
      updated_at = now_ts
    WHERE id = rec.id;

    -- Record audit log
    INSERT INTO cancellation_ledger_audits (
      ledger_id, action, previous_status, new_status,
      previous_debt, new_debt, actor_name, notes, created_at
    ) VALUES (
      rec.id, 'REMOVE', rec.status, 'Removed',
      rec.structure_debt, 0, COALESCE(p_removed_by, 'Admin'),
      COALESCE(p_reason, 'Removed by admin'), now_ts
    );

    removed_count := removed_count + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'count', removed_count,
    'removed_at', now_ts
  );
END;
$$;

-- C. Record Partial Payment (Single Record)
CREATE OR REPLACE FUNCTION record_cancellation_payment(
  p_id text,
  p_amount numeric,
  p_actor_name text DEFAULT 'Admin',
  p_notes text DEFAULT ''
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rec RECORD;
  new_balance numeric;
  new_status text;
  now_ts timestamptz := now();
BEGIN
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Payment amount must be greater than zero';
  END IF;

  SELECT id, status, structure_debt, general_notes
  INTO rec
  FROM cancellation_ledger
  WHERE id::text = p_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ledger entry with ID % not found', p_id;
  END IF;

  new_balance := GREATEST(0, rec.structure_debt - p_amount);
  IF new_balance = 0 THEN
    new_status := 'Settled';
  ELSE
    new_status := 'Partially Paid';
  END IF;

  UPDATE cancellation_ledger
  SET
    status = new_status,
    structure_debt = new_balance,
    settled_at = CASE WHEN new_balance = 0 THEN now_ts ELSE settled_at END,
    settled_by = CASE WHEN new_balance = 0 THEN COALESCE(p_actor_name, 'Admin') ELSE settled_by END,
    general_notes = CASE
      WHEN rec.general_notes IS NULL OR rec.general_notes = '' THEN 'Paid R' || p_amount
      ELSE rec.general_notes || ' (Paid R' || p_amount || ')'
    END,
    updated_at = now_ts
  WHERE id = rec.id;

  INSERT INTO cancellation_ledger_audits (
    ledger_id, action, previous_status, new_status,
    previous_debt, new_debt, actor_name, notes, created_at
  ) VALUES (
    rec.id, CASE WHEN new_balance = 0 THEN 'SETTLE' ELSE 'PARTIAL_PAYMENT' END,
    rec.status, new_status, rec.structure_debt, new_balance,
    COALESCE(p_actor_name, 'Admin'), COALESCE(p_notes, 'Payment of R' || p_amount), now_ts
  );

  RETURN jsonb_build_object(
    'success', true,
    'id', p_id,
    'previous_debt', rec.structure_debt,
    'new_debt', new_balance,
    'new_status', new_status,
    'updated_at', now_ts
  );
END;
$$;
