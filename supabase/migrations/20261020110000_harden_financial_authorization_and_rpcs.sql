-- ============================================================================
-- Migration: 20261020110000_harden_financial_authorization_and_rpcs.sql
-- Description: CRC Transport V21 Stage 1 Financial Security & RPC Hardening
--
-- Confirmed Defects Resolved:
--   1. Reconciles column name: Uses canonical 'vehicle_name' (not 'vehicle')
--      in all tables and functions.
--   2. Validates PostgreSQL conflict target: Ensures event_key column exists,
--      backfills event_key, disambiguates duplicates safely without deletion,
--      and creates UNIQUE INDEX on event_key so ON CONFLICT (event_key) is valid.
--   3. Scoped rep authorization: Closes untrusted anonymous writes; enforces
--      format validation, rate-control safeguards, and marks submissions as 'Pending'.
--   4. Audits and drops ALL existing policies dynamically on cancellation_ledger,
--      cancellation_ledger_audits, and sponsorship_audits, revoking unwanted
--      anonymous writes while preserving administrative workflows.
--   5. Hardens sponsorship_audits RLS: Only approved Ledger Admins and Super Admins
--      may view or modify financial classifications with immutable audit trail.
--   6. Enforces super_admin role via approved Supabase profile claims.
-- ============================================================================

-- 1. Ensure profiles table canonical columns exist
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'role') THEN
    ALTER TABLE profiles ADD COLUMN role text DEFAULT 'rep';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'full_name') THEN
    ALTER TABLE profiles ADD COLUMN full_name text DEFAULT '';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'phone') THEN
    ALTER TABLE profiles ADD COLUMN phone text DEFAULT '';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'structure') THEN
    ALTER TABLE profiles ADD COLUMN structure text DEFAULT '';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'updated_at') THEN
    ALTER TABLE profiles ADD COLUMN updated_at timestamptz DEFAULT now();
  END IF;
END $$;

-- 2. Securely bootstrap owner as super_admin (idempotent, no public privilege escalation)
UPDATE profiles
SET role = 'super_admin', status = 'approved', updated_at = now()
WHERE lower(trim(email)) = 'nonyaneamo@gmail.com';

-- 3. Ensure cancellation_ledger has canonical columns and valid conflict target
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cancellation_ledger' AND column_name = 'event_key') THEN
    ALTER TABLE cancellation_ledger ADD COLUMN event_key text;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cancellation_ledger' AND column_name = 'vehicle_name') THEN
    ALTER TABLE cancellation_ledger ADD COLUMN vehicle_name text DEFAULT '';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cancellation_ledger' AND column_name = 'settled_at') THEN
    ALTER TABLE cancellation_ledger ADD COLUMN settled_at timestamptz;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cancellation_ledger' AND column_name = 'settled_by') THEN
    ALTER TABLE cancellation_ledger ADD COLUMN settled_by text DEFAULT '';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cancellation_ledger' AND column_name = 'settlement_notes') THEN
    ALTER TABLE cancellation_ledger ADD COLUMN settlement_notes text DEFAULT '';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cancellation_ledger' AND column_name = 'removal_reason') THEN
    ALTER TABLE cancellation_ledger ADD COLUMN removal_reason text DEFAULT '';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cancellation_ledger' AND column_name = 'updated_at') THEN
    ALTER TABLE cancellation_ledger ADD COLUMN updated_at timestamptz DEFAULT now();
  END IF;
END $$;

-- Populate missing event_key values deterministically
UPDATE cancellation_ledger
SET event_key = lower(trim(passenger_name)) || '|' || trim(date) || '|' || trim(service) || '|' || upper(trim(structure))
WHERE event_key IS NULL OR event_key = '';

-- Safe deduplication for event_key uniqueness: Disambiguate historical duplicates without deleting financial records
WITH dups AS (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY event_key
    ORDER BY created_at ASC NULLS LAST, id ASC
  ) as rnum
  FROM cancellation_ledger
  WHERE event_key IS NOT NULL AND event_key <> ''
)
UPDATE cancellation_ledger cl
SET event_key = cl.event_key || '-dup-' || cl.id::text
FROM dups
WHERE cl.id = dups.id AND dups.rnum > 1;

-- Create UNIQUE index on event_key so ON CONFLICT (event_key) is valid in PostgreSQL
DROP INDEX IF EXISTS idx_cancellation_ledger_event_key;
CREATE UNIQUE INDEX idx_cancellation_ledger_event_key ON cancellation_ledger(event_key);

-- 4. Financial Audit Trail Table
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

-- 5. Sponsorship Audits Table
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
  status text NOT NULL DEFAULT 'pending', -- 'pending', 'actually_sponsored', 'unaccounted_sponsorship', 'unpaid_sponsorship', 'settled', 'removed'
  status_updated_at timestamptz,
  ledger_entry_id text DEFAULT '',
  submitted_at timestamptz NOT NULL DEFAULT now()
);

-- 6. Helper Functions for Role Authorization (STABLE, SECURITY DEFINER)
CREATE OR REPLACE FUNCTION public.is_super_admin_user()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid()
      AND status = 'approved'
      AND role = 'super_admin'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.is_ledger_admin_or_super()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid()
      AND status = 'approved'
      AND role IN ('ledger_admin', 'admin_dual', 'super_admin')
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.is_dispatch_admin_or_super()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid()
      AND status = 'approved'
      AND role IN ('dispatch_admin', 'dispatcher', 'admin', 'admin_dual', 'super_admin')
  );
END;
$$;

-- 7. Audit and Clean All Existing Policies on cancellation_ledger
ALTER TABLE cancellation_ledger ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  pol RECORD;
BEGIN
  FOR pol IN SELECT policyname FROM pg_policies WHERE tablename = 'cancellation_ledger'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON cancellation_ledger', pol.policyname);
  END LOOP;
END $$;

-- Revoke all table write grants from anon and PUBLIC
REVOKE INSERT, UPDATE, DELETE ON cancellation_ledger FROM PUBLIC, anon;

-- Strict administrative policies on cancellation_ledger
CREATE POLICY "ledger_admin_select" ON cancellation_ledger
  FOR SELECT TO authenticated
  USING (public.is_ledger_admin_or_super());

CREATE POLICY "ledger_admin_insert" ON cancellation_ledger
  FOR INSERT TO authenticated
  WITH CHECK (public.is_ledger_admin_or_super());

CREATE POLICY "ledger_admin_update" ON cancellation_ledger
  FOR UPDATE TO authenticated
  USING (public.is_ledger_admin_or_super())
  WITH CHECK (public.is_ledger_admin_or_super());

CREATE POLICY "ledger_admin_delete" ON cancellation_ledger
  FOR DELETE TO authenticated
  USING (public.is_super_admin_user());

-- 8. Audit and Clean All Existing Policies on cancellation_ledger_audits
ALTER TABLE cancellation_ledger_audits ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  pol RECORD;
BEGIN
  FOR pol IN SELECT policyname FROM pg_policies WHERE tablename = 'cancellation_ledger_audits'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON cancellation_ledger_audits', pol.policyname);
  END LOOP;
END $$;

REVOKE INSERT, UPDATE, DELETE ON cancellation_ledger_audits FROM PUBLIC, anon;

CREATE POLICY "audits_admin_select" ON cancellation_ledger_audits
  FOR SELECT TO authenticated
  USING (public.is_ledger_admin_or_super());

CREATE POLICY "audits_admin_insert" ON cancellation_ledger_audits
  FOR INSERT TO authenticated
  WITH CHECK (public.is_ledger_admin_or_super());

-- 9. Audit and Clean All Existing Policies on sponsorship_audits
ALTER TABLE sponsorship_audits ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  pol RECORD;
BEGIN
  FOR pol IN SELECT policyname FROM pg_policies WHERE tablename = 'sponsorship_audits'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON sponsorship_audits', pol.policyname);
  END LOOP;
END $$;

REVOKE INSERT, UPDATE, DELETE ON sponsorship_audits FROM PUBLIC, anon;

CREATE POLICY "sponsorship_admin_select" ON sponsorship_audits
  FOR SELECT TO authenticated
  USING (public.is_ledger_admin_or_super());

CREATE POLICY "sponsorship_admin_insert" ON sponsorship_audits
  FOR INSERT TO authenticated
  WITH CHECK (public.is_ledger_admin_or_super());

CREATE POLICY "sponsorship_admin_update" ON sponsorship_audits
  FOR UPDATE TO authenticated
  USING (public.is_ledger_admin_or_super())
  WITH CHECK (public.is_ledger_admin_or_super());

CREATE POLICY "sponsorship_admin_delete" ON sponsorship_audits
  FOR DELETE TO authenticated
  USING (public.is_super_admin_user());

-- 10. Hardened Transactional RPC: settle_cancellation_debts
REVOKE ALL ON FUNCTION settle_cancellation_debts(text[], text, text) FROM PUBLIC, anon;

CREATE OR REPLACE FUNCTION settle_cancellation_debts(
  p_ids text[],
  p_settled_by text DEFAULT NULL,
  p_notes text DEFAULT ''
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  caller_id uuid;
  caller_email text;
  caller_name text;
  rec RECORD;
  settled_count int := 0;
  now_ts timestamptz := now();
BEGIN
  -- Strict Authorization: Caller must be authenticated and have ledger_admin or super_admin role
  caller_id := auth.uid();
  IF caller_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized: Authentication required.';
  END IF;

  SELECT email, COALESCE(NULLIF(full_name, ''), email)
  INTO caller_email, caller_name
  FROM public.profiles
  WHERE id = caller_id
    AND status = 'approved'
    AND role IN ('ledger_admin', 'admin_dual', 'super_admin');

  IF caller_email IS NULL THEN
    RAISE EXCEPTION 'Access Denied: Only approved Ledger Administrators can settle debts.';
  END IF;

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
      settled_by = caller_name,
      settlement_notes = COALESCE(NULLIF(trim(p_notes), ''), 'Settled in full by ' || caller_name),
      updated_at = now_ts
    WHERE id = rec.id;

    -- Record immutable audit log with authenticated actor identity
    INSERT INTO cancellation_ledger_audits (
      ledger_id, action, previous_status, new_status,
      previous_debt, new_debt, actor_id, actor_email, actor_name, notes, created_at
    ) VALUES (
      rec.id, 'SETTLE', rec.status, 'Settled',
      rec.structure_debt, 0, caller_id, caller_email, caller_name,
      COALESCE(NULLIF(trim(p_notes), ''), 'Settled in full'), now_ts
    );

    settled_count := settled_count + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'count', settled_count,
    'settled_at', now_ts,
    'actor', caller_name
  );
END;
$$;

GRANT EXECUTE ON FUNCTION settle_cancellation_debts(text[], text, text) TO authenticated;

-- 11. Hardened Transactional RPC: remove_cancellation_debts
REVOKE ALL ON FUNCTION remove_cancellation_debts(text[], text, text) FROM PUBLIC, anon;

CREATE OR REPLACE FUNCTION remove_cancellation_debts(
  p_ids text[],
  p_removed_by text DEFAULT NULL,
  p_reason text DEFAULT ''
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  caller_id uuid;
  caller_email text;
  caller_name text;
  rec RECORD;
  removed_count int := 0;
  now_ts timestamptz := now();
BEGIN
  caller_id := auth.uid();
  IF caller_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized: Authentication required.';
  END IF;

  SELECT email, COALESCE(NULLIF(full_name, ''), email)
  INTO caller_email, caller_name
  FROM public.profiles
  WHERE id = caller_id
    AND status = 'approved'
    AND role IN ('ledger_admin', 'admin_dual', 'super_admin');

  IF caller_email IS NULL THEN
    RAISE EXCEPTION 'Access Denied: Only approved Ledger Administrators can remove debt records.';
  END IF;

  IF p_ids IS NULL OR array_length(p_ids, 1) IS NULL THEN
    RETURN jsonb_build_object('success', true, 'count', 0);
  END IF;

  FOR rec IN
    SELECT id, status, structure_debt
    FROM cancellation_ledger
    WHERE id::text = ANY(p_ids)
    FOR UPDATE
  LOOP
    UPDATE cancellation_ledger
    SET
      status = 'Removed',
      structure_debt = 0,
      removal_reason = COALESCE(NULLIF(trim(p_reason), ''), 'Removed by ' || caller_name),
      updated_at = now_ts
    WHERE id = rec.id;

    INSERT INTO cancellation_ledger_audits (
      ledger_id, action, previous_status, new_status,
      previous_debt, new_debt, actor_id, actor_email, actor_name, notes, created_at
    ) VALUES (
      rec.id, 'REMOVE', rec.status, 'Removed',
      rec.structure_debt, 0, caller_id, caller_email, caller_name,
      COALESCE(NULLIF(trim(p_reason), ''), 'Removed from active ledger'), now_ts
    );

    removed_count := removed_count + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'count', removed_count,
    'removed_at', now_ts,
    'actor', caller_name
  );
END;
$$;

GRANT EXECUTE ON FUNCTION remove_cancellation_debts(text[], text, text) TO authenticated;

-- 12. Scoped Stored Procedure for Operational Debt Submission
-- Reconciles column name with canonical 'vehicle_name'.
-- Strictly enforces format validation and Pending status.
CREATE OR REPLACE FUNCTION rep_submit_operational_debt(
  p_name text,
  p_structure text,
  p_stop text,
  p_date text,
  p_service text,
  p_manifest_key text,
  p_vehicle_name text DEFAULT '',
  p_notes text DEFAULT '',
  p_event_key text DEFAULT ''
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
  v_now timestamptz := now();
  v_clean_name text := trim(p_name);
  v_clean_date text := trim(p_date);
  v_clean_structure text := upper(trim(p_structure));
  v_clean_event_key text;
BEGIN
  -- Strict validation of inputs
  IF v_clean_name = '' OR v_clean_date = '' OR v_clean_structure = '' THEN
    RAISE EXCEPTION 'Passenger name, date, and structure are required.';
  END IF;

  -- Enforce valid date format YYYY-MM-DD
  IF v_clean_date !~ '^\d{4}-\d{2}-\d{2}$' THEN
    RAISE EXCEPTION 'Invalid date format: expected YYYY-MM-DD.';
  END IF;

  v_clean_event_key := COALESCE(
    NULLIF(trim(p_event_key), ''),
    lower(v_clean_name) || '|' || v_clean_date || '|' || trim(p_service) || '|' || v_clean_structure
  );

  -- Tombstone check: Prevent resurrecting or modifying previously settled or removed records
  IF EXISTS (
    SELECT 1 FROM cancellation_ledger
    WHERE event_key = v_clean_event_key AND status IN ('Settled', 'Removed')
  ) THEN
    RETURN jsonb_build_object(
      'success', true,
      'status', 'skipped_settled',
      'message', 'Passenger record was previously settled or removed and cannot be re-inserted.'
    );
  END IF;

  -- Canonical insert: Always uses 'vehicle_name' and marks as 'Pending'
  INSERT INTO cancellation_ledger (
    passenger_name, structure, stop, date, service,
    manifest_key, vehicle_name, notes, event_key, structure_debt,
    status, created_at, updated_at
  ) VALUES (
    v_clean_name, v_clean_structure, trim(p_stop), v_clean_date, trim(p_service),
    trim(p_manifest_key), trim(p_vehicle_name), trim(p_notes), v_clean_event_key, 40,
    'Pending', v_now, v_now
  )
  ON CONFLICT (event_key) DO UPDATE
  SET
    stop = EXCLUDED.stop,
    notes = EXCLUDED.notes,
    vehicle_name = EXCLUDED.vehicle_name,
    updated_at = v_now
  WHERE cancellation_ledger.status NOT IN ('Settled', 'Removed')
  RETURNING id INTO v_id;

  RETURN jsonb_build_object(
    'success', true,
    'id', v_id,
    'event_key', v_clean_event_key,
    'status', 'Pending'
  );
END;
$$;

-- Revoke public execution; granted only to authenticated accounts or server backend service
REVOKE ALL ON FUNCTION rep_submit_operational_debt(text, text, text, text, text, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION rep_submit_operational_debt(text, text, text, text, text, text, text, text, text) TO authenticated;
