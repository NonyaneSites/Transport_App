-- ============================================================================
-- Migration: 20261020110000_harden_financial_authorization_and_rpcs.sql
-- Description: P0 Financial Authorization & RPC Hardening for V20
--   1. Ensures profiles table has canonical role, status, and metadata columns.
--   2. Securely provisions owner 'nonyaneamo@gmail.com' as super_admin.
--   3. Revokes anonymous permissive SELECT/INSERT/UPDATE on cancellation_ledger
--      and cancellation_ledger_audits.
--   4. Enforces strict auth.uid() role checks (super_admin, ledger_admin) on all
--      financial RPCs (settle_cancellation_debts, remove_cancellation_debts).
--   5. Fixes safe search_path = public, pg_temp and derives actor identity from auth.
--   6. Introduces scoped rep RPC for account-free operational submissions.
-- ============================================================================

-- 1. Ensure profiles table columns exist
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

-- 2. Securely provision owner as super_admin (idempotent, no public elevation)
UPDATE profiles
SET role = 'super_admin', status = 'approved', updated_at = now()
WHERE lower(trim(email)) = 'nonyaneamo@gmail.com';

-- 3. Helper Functions for Role Authorization (STABLE, SECURITY DEFINER)
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
      AND (role = 'super_admin' OR lower(trim(email)) = 'nonyaneamo@gmail.com')
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
      AND (role IN ('ledger_admin', 'super_admin') OR lower(trim(email)) = 'nonyaneamo@gmail.com')
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
      AND (role IN ('dispatch_admin', 'dispatcher', 'admin', 'super_admin') OR lower(trim(email)) = 'nonyaneamo@gmail.com')
  );
END;
$$;

-- 4. Revoke and Re-create RLS Policies on cancellation_ledger
ALTER TABLE cancellation_ledger ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_ledger" ON cancellation_ledger;
DROP POLICY IF EXISTS "anon_insert_ledger" ON cancellation_ledger;
DROP POLICY IF EXISTS "anon_update_ledger" ON cancellation_ledger;
DROP POLICY IF EXISTS "ledger_select_policy" ON cancellation_ledger;
DROP POLICY IF EXISTS "ledger_insert_policy" ON cancellation_ledger;
DROP POLICY IF EXISTS "ledger_update_policy" ON cancellation_ledger;
DROP POLICY IF EXISTS "ledger_delete_policy" ON cancellation_ledger;

-- SELECT: Only approved Ledger Admins and Super Admins can read full PII and financial ledger
CREATE POLICY "ledger_select_policy" ON cancellation_ledger
  FOR SELECT TO authenticated
  USING (public.is_ledger_admin_or_super());

-- INSERT: Only authenticated Ledger Admins and Super Admins can insert directly
CREATE POLICY "ledger_insert_policy" ON cancellation_ledger
  FOR INSERT TO authenticated
  WITH CHECK (public.is_ledger_admin_or_super());

-- UPDATE: Only authenticated Ledger Admins and Super Admins can update financial records
CREATE POLICY "ledger_update_policy" ON cancellation_ledger
  FOR UPDATE TO authenticated
  USING (public.is_ledger_admin_or_super())
  WITH CHECK (public.is_ledger_admin_or_super());

-- DELETE: Only Super Admin can hard delete
CREATE POLICY "ledger_delete_policy" ON cancellation_ledger
  FOR DELETE TO authenticated
  USING (public.is_super_admin_user());

-- 5. Revoke and Re-create RLS Policies on cancellation_ledger_audits
ALTER TABLE cancellation_ledger_audits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "audits_select_policy" ON cancellation_ledger_audits;
DROP POLICY IF EXISTS "audits_insert_policy" ON cancellation_ledger_audits;
DROP POLICY IF EXISTS "audits_update_policy" ON cancellation_ledger_audits;
DROP POLICY IF EXISTS "audits_delete_policy" ON cancellation_ledger_audits;

-- Audit logs are strictly immutable: no client updates or deletes
CREATE POLICY "audits_select_policy" ON cancellation_ledger_audits
  FOR SELECT TO authenticated
  USING (public.is_ledger_admin_or_super());

CREATE POLICY "audits_insert_policy" ON cancellation_ledger_audits
  FOR INSERT TO authenticated
  WITH CHECK (public.is_ledger_admin_or_super());

-- 6. Hardened Transactional RPC: settle_cancellation_debts
-- Revoke public execution
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
    AND (role IN ('ledger_admin', 'super_admin') OR lower(trim(email)) = 'nonyaneamo@gmail.com');

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

-- 7. Hardened Transactional RPC: remove_cancellation_debts
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
    AND (role IN ('ledger_admin', 'super_admin') OR lower(trim(email)) = 'nonyaneamo@gmail.com');

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
    -- Mark logically removed
    UPDATE cancellation_ledger
    SET
      status = 'Removed',
      structure_debt = 0,
      removal_reason = COALESCE(NULLIF(trim(p_reason), ''), 'Removed by ' || caller_name),
      updated_at = now_ts
    WHERE id = rec.id;

    -- Record immutable audit log
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

-- 8. Scoped Stored Procedure for Account-Free Transport Rep Operational Reports
-- Allows reps to submit absentee cancellation entries without direct table write privileges
CREATE OR REPLACE FUNCTION rep_submit_operational_debt(
  p_name text,
  p_structure text,
  p_stop text,
  p_date text,
  p_service text,
  p_manifest_key text,
  p_vehicle text DEFAULT '',
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
  IF v_clean_name = '' OR v_clean_date = '' OR v_clean_structure = '' THEN
    RAISE EXCEPTION 'Passenger name, date, and structure are required.';
  END IF;

  v_clean_event_key := COALESCE(NULLIF(trim(p_event_key), ''), lower(v_clean_name) || '|' || v_clean_date || '|' || trim(p_service) || '|' || v_clean_structure);

  -- Prevent resurrecting or duplicating already settled or removed entries
  IF EXISTS (
    SELECT 1 FROM cancellation_ledger
    WHERE event_key = v_clean_event_key AND status IN ('Settled', 'Removed')
  ) THEN
    RETURN jsonb_build_object(
      'success', true,
      'status', 'skipped_settled',
      'message', 'Passenger event was previously resolved/settled and cannot be re-inserted.'
    );
  END IF;

  INSERT INTO cancellation_ledger (
    passenger_name, structure, stop, date, service,
    manifest_key, vehicle, notes, event_key, structure_debt,
    status, created_at, updated_at
  ) VALUES (
    v_clean_name, v_clean_structure, trim(p_stop), v_clean_date, trim(p_service),
    trim(p_manifest_key), trim(p_vehicle), trim(p_notes), v_clean_event_key, 40,
    'Pending', v_now, v_now
  )
  ON CONFLICT (event_key) DO UPDATE
  SET
    stop = EXCLUDED.stop,
    notes = EXCLUDED.notes,
    vehicle = EXCLUDED.vehicle,
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

GRANT EXECUTE ON FUNCTION rep_submit_operational_debt(text, text, text, text, text, text, text, text, text) TO anon, authenticated;
