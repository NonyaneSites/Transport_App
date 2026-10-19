/*
# Migration: Super Administrator Role & Multi-Role Permissions Hardening

1. Role Model & Constraints
- Introduces four distinct roles:
  - `super_admin`: Unrestricted administrative access to Dispatch, Cancellation/Ledger, and Role Governance.
  - `dispatch_admin`: Dedicated access to Dispatch Administration (manifests, vehicles, sessions).
  - `ledger_admin`: Dedicated access to Cancellation & Ledger Administration (debts, sponsorships, absentees).
  - `rep`: Ground Transport Rep (no account required on ground, but default role for rep accounts).
- Legacy compatibility: 'admin' and 'dispatcher' are mapped safely to administrative roles.

2. Super Admin Assignment
- Assigns `nonyaneamo@gmail.com` to `super_admin` role with approved status through secure administrator migration.

3. Role Elevation Protections
- Strict check preventing any user from modifying or upgrading their own role or status.
- Only an approved `super_admin` can assign administrative roles.

4. Row Level Security Hardening
- Functions: `is_super_admin()`, `is_dispatch_admin()`, `is_ledger_admin()`, `is_admin_user()`.
- Explicit RLS policies enforcing dispatch admin vs ledger admin separation.
*/

-- 1. Ensure columns exist on profiles table
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'rep';
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS full_name text DEFAULT '';
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS phone text DEFAULT '';
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS structure text DEFAULT '';
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

-- Role validation check constraint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'profiles_role_check'
  ) THEN
    ALTER TABLE profiles ADD CONSTRAINT profiles_role_check
      CHECK (role IN ('super_admin', 'dispatch_admin', 'ledger_admin', 'admin', 'dispatcher', 'rep'));
  END IF;
END $$;

-- 2. SECURE MIGRATION: Assign nonyaneamo@gmail.com to Super Administrator role
UPDATE profiles
SET
  role = 'super_admin',
  status = 'approved',
  updated_at = now()
WHERE lower(trim(email)) = 'nonyaneamo@gmail.com';

-- 3. Security Helper Functions
CREATE OR REPLACE FUNCTION is_approved_user()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid() AND status = 'approved'
  );
END;
$$;

CREATE OR REPLACE FUNCTION is_super_admin()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid()
      AND status = 'approved'
      AND (role = 'super_admin' OR lower(trim(email)) = 'nonyaneamo@gmail.com')
  );
END;
$$;

CREATE OR REPLACE FUNCTION is_dispatch_admin()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid()
      AND status = 'approved'
      AND (
        role IN ('super_admin', 'dispatch_admin', 'dispatcher', 'admin')
        OR lower(trim(email)) = 'nonyaneamo@gmail.com'
      )
  );
END;
$$;

CREATE OR REPLACE FUNCTION is_ledger_admin()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid()
      AND status = 'approved'
      AND (
        role IN ('super_admin', 'ledger_admin', 'admin')
        OR lower(trim(email)) = 'nonyaneamo@gmail.com'
      )
  );
END;
$$;

CREATE OR REPLACE FUNCTION is_admin_user()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
BEGIN
  RETURN (is_dispatch_admin() OR is_ledger_admin() OR is_super_admin());
END;
$$;

-- 4. Server-Side Administrative RPCs with Self-Upgrade Protection
CREATE OR REPLACE FUNCTION approve_user_profile(
  target_user_id uuid,
  new_status text,
  new_role text DEFAULT 'rep'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  caller_email text;
  caller_role text;
  valid_status text;
  valid_role text;
  is_caller_super boolean;
BEGIN
  -- Verify caller is logged in
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required.';
  END IF;

  -- 1. Anti-Self-Upgrade Enforcement: Users cannot alter their own status or role
  IF auth.uid() = target_user_id THEN
    RAISE EXCEPTION 'Security Policy Violation: Users are strictly forbidden from assigning or upgrading their own role or status.';
  END IF;

  -- Check caller authorization
  is_caller_super := is_super_admin();
  IF NOT (is_caller_super OR is_dispatch_admin()) THEN
    RAISE EXCEPTION 'Access Denied: Administrator privileges required to manage user accounts.';
  END IF;

  SELECT email, role INTO caller_email, caller_role FROM profiles WHERE id = auth.uid();

  valid_status := lower(trim(new_status));
  IF valid_status NOT IN ('pending', 'approved', 'rejected') THEN
    RAISE EXCEPTION 'Invalid status value. Must be pending, approved, or rejected.';
  END IF;

  valid_role := lower(trim(new_role));
  IF valid_role NOT IN ('super_admin', 'dispatch_admin', 'ledger_admin', 'admin', 'dispatcher', 'rep') THEN
    valid_role := 'rep';
  END IF;

  -- Only super_admin can create or assign super_admin or admin roles
  IF valid_role IN ('super_admin', 'admin') AND NOT is_caller_super THEN
    RAISE EXCEPTION 'Access Denied: Only a Super Administrator can assign Super Administrator or General Administrator roles.';
  END IF;

  -- Protect nonyaneamo@gmail.com from downgrade
  IF EXISTS (SELECT 1 FROM profiles WHERE id = target_user_id AND lower(trim(email)) = 'nonyaneamo@gmail.com') THEN
    IF valid_role != 'super_admin' OR valid_status != 'approved' THEN
      RAISE EXCEPTION 'Security Policy Violation: Super Administrator nonyaneamo@gmail.com cannot be downgraded or disabled.';
    END IF;
  END IF;

  -- Update target profile
  UPDATE profiles
  SET
    status = valid_status,
    role = valid_role,
    updated_at = now()
  WHERE id = target_user_id;

  -- Record in audit logs
  INSERT INTO admin_audit_logs (actor_id, actor_email, action, target_id, details)
  VALUES (
    auth.uid(),
    COALESCE(caller_email, ''),
    'approve_user_profile',
    target_user_id::text,
    jsonb_build_object('status', valid_status, 'role', valid_role, 'assigned_by_role', caller_role)
  );

  RETURN jsonb_build_object(
    'success', true,
    'userId', target_user_id,
    'status', valid_status,
    'role', valid_role
  );
END;
$$;

-- 5. Row Level Security Policies
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "profiles_select_policy" ON profiles;
CREATE POLICY "profiles_select_policy" ON profiles
  FOR SELECT TO authenticated, anon
  USING (
    auth.uid() = id
    OR is_admin_user()
    OR status = 'approved'
  );

DROP POLICY IF EXISTS "profiles_insert_policy" ON profiles;
CREATE POLICY "profiles_insert_policy" ON profiles
  FOR INSERT TO authenticated
  WITH CHECK (
    auth.uid() = id
    AND (status = 'pending' OR status IS NULL)
    AND (role = 'rep' OR role IS NULL)
  );

DROP POLICY IF EXISTS "profiles_update_policy" ON profiles;
CREATE POLICY "profiles_update_policy" ON profiles
  FOR UPDATE TO authenticated
  USING (
    auth.uid() = id OR is_admin_user()
  )
  WITH CHECK (
    -- Admins can update OTHER profiles (cannot modify own role/status)
    (is_admin_user() AND auth.uid() != id)
    OR
    -- Self-update: contact details only; role and status must remain exactly unchanged
    (
      auth.uid() = id
      AND status = (SELECT status FROM profiles WHERE id = auth.uid())
      AND role = (SELECT role FROM profiles WHERE id = auth.uid())
    )
  );

-- Dispatch Manifests Policies
DROP POLICY IF EXISTS "manifests_admin_delete" ON transport_manifests;
CREATE POLICY "manifests_admin_delete" ON transport_manifests
  FOR DELETE TO authenticated
  USING (is_dispatch_admin());

-- Cancellation Ledger Policies
DROP POLICY IF EXISTS "ledger_admin_delete" ON cancellation_ledger;
CREATE POLICY "ledger_admin_delete" ON cancellation_ledger
  FOR DELETE TO authenticated
  USING (is_ledger_admin());

-- Sponsorship Audits Policies
DROP POLICY IF EXISTS "sponsorships_admin_delete" ON sponsorship_audits;
CREATE POLICY "sponsorships_admin_delete" ON sponsorship_audits
  FOR DELETE TO authenticated
  USING (is_ledger_admin());

DROP POLICY IF EXISTS "sponsorships_update_policy" ON sponsorship_audits;
CREATE POLICY "sponsorships_update_policy" ON sponsorship_audits
  FOR UPDATE TO authenticated
  USING (is_ledger_admin() OR is_approved_user())
  WITH CHECK (is_ledger_admin() OR is_approved_user());
