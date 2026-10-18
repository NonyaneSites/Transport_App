/*
# Security & Reliability Hardening: Least-Privilege RLS & Server-Side Admin RPCs

1. Profiles Table Additions
- Adds missing profile columns: `role`, `full_name`, `phone`, `structure`, `updated_at`.
- Ensures existing approved users have valid roles ('admin' or 'rep').

2. Admin Audit Logs
- Creates `admin_audit_logs` table for tracking privileged actions (session resets, role changes, account approvals).

3. Server-Side Security Functions
- `is_approved_user()`: Checks if current auth.uid() has an approved status.
- `is_admin_user()`: Checks if current auth.uid() is an approved administrator.
- `approve_user_profile(target_user_id, new_status, new_role)`: SECURITY DEFINER RPC for safely approving/configuring user roles.
- `reset_manifest_session(manifest_key, confirmation)`: SECURITY DEFINER RPC for safely resetting an active session with confirmation and audit logging.

4. Least-Privilege RLS Policies
- Eliminates unrestricted anon DELETE policies on `transport_manifests`, `cancellation_ledger`, `sponsorship_audits`.
- Restricts `profiles` updates to prevent self-promotion and unauthorized privilege escalation.
- Preserves anonymous read and vehicle submission needed by Transport Reps on ground (/ and /rep).
*/

-- 1. Profiles Table Enhancements
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'rep';
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS full_name text DEFAULT '';
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS phone text DEFAULT '';
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS structure text DEFAULT '';
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

-- Default existing initial admin accounts to admin role if currently rep
UPDATE profiles
SET role = 'admin'
WHERE email IN ('nonyaneamo@gmail.com', 'shauntsiloane@gmail.com', 'tsiloane941@gmail.com')
  AND (role = 'rep' OR role IS NULL);

-- 2. Admin Audit Logs Table
CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid REFERENCES auth.users(id),
  actor_email text DEFAULT '',
  action text NOT NULL,
  target_id text DEFAULT '',
  details jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE admin_audit_logs ENABLE ROW LEVEL SECURITY;

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

CREATE OR REPLACE FUNCTION is_admin_user()
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
    WHERE id = auth.uid() AND status = 'approved' AND role = 'admin'
  );
END;
$$;

-- 4. Privileged Server-Side RPC Functions
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
  valid_status text;
  valid_role text;
BEGIN
  -- Verify caller is an approved admin
  IF NOT is_admin_user() THEN
    RAISE EXCEPTION 'Access Denied: Only approved administrators can manage account authorization';
  END IF;

  SELECT email INTO caller_email FROM auth.users WHERE id = auth.uid();

  valid_status := lower(trim(new_status));
  IF valid_status NOT IN ('pending', 'approved', 'rejected') THEN
    RAISE EXCEPTION 'Invalid status. Must be pending, approved, or rejected.';
  END IF;

  valid_role := lower(trim(new_role));
  IF valid_role NOT IN ('rep', 'admin', 'dispatcher') THEN
    valid_role := 'rep';
  END IF;

  -- Update target profile
  UPDATE profiles
  SET
    status = valid_status,
    role = valid_role,
    updated_at = now()
  WHERE id = target_user_id;

  -- Record audit log
  INSERT INTO admin_audit_logs (actor_id, actor_email, action, target_id, details)
  VALUES (
    auth.uid(),
    caller_email,
    'approve_user_profile',
    target_user_id::text,
    jsonb_build_object('status', valid_status, 'role', valid_role)
  );

  RETURN jsonb_build_object(
    'success', true,
    'userId', target_user_id,
    'status', valid_status,
    'role', valid_role
  );
END;
$$;

CREATE OR REPLACE FUNCTION reset_manifest_session(
  p_manifest_key text,
  confirmation text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  caller_email text;
BEGIN
  -- Verify caller is an approved admin
  IF NOT is_admin_user() THEN
    RAISE EXCEPTION 'Access Denied: Only approved administrators can reset manifest sessions';
  END IF;

  IF upper(trim(confirmation)) NOT IN ('RESET', 'CONFIRM_RESET') THEN
    RAISE EXCEPTION 'Invalid confirmation token. You must explicitly type RESET to confirm.';
  END IF;

  SELECT email INTO caller_email FROM auth.users WHERE id = auth.uid();

  -- Clear allocations and signups on the manifest
  UPDATE transport_manifests
  SET
    signups = '[]'::jsonb,
    vehicles = '[]'::jsonb,
    updated_at = now()
  WHERE transport_manifests.date = p_manifest_key;

  -- Record audit log
  INSERT INTO admin_audit_logs (actor_id, actor_email, action, target_id, details)
  VALUES (
    auth.uid(),
    caller_email,
    'reset_manifest_session',
    p_manifest_key,
    jsonb_build_object('manifest_key', p_manifest_key, 'timestamp', now())
  );

  RETURN jsonb_build_object(
    'success', true,
    'manifest_key', p_manifest_key,
    'reset_at', now()
  );
END;
$$;

-- 5. Least-Privilege Policies for Profiles Table
DROP POLICY IF EXISTS "profiles_select_policy" ON profiles;
DROP POLICY IF EXISTS "profiles_insert_policy" ON profiles;
DROP POLICY IF EXISTS "profiles_update_policy" ON profiles;
DROP POLICY IF EXISTS "profiles_delete_policy" ON profiles;
DROP POLICY IF EXISTS "anon_select_profiles" ON profiles;
DROP POLICY IF EXISTS "anon_insert_profiles" ON profiles;
DROP POLICY IF EXISTS "anon_update_profiles" ON profiles;
DROP POLICY IF EXISTS "anon_delete_profiles" ON profiles;

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- Users can read their own profile; approved users can view other profiles
CREATE POLICY "profiles_select_policy" ON profiles
  FOR SELECT TO authenticated, anon
  USING (
    auth.uid() = id
    OR is_approved_user()
    OR is_admin_user()
    OR status = 'approved'
  );

-- Users can insert only their own profile upon signup, strictly as pending rep
CREATE POLICY "profiles_insert_policy" ON profiles
  FOR INSERT TO authenticated
  WITH CHECK (
    auth.uid() = id
    AND (status = 'pending' OR status IS NULL)
    AND (role = 'rep' OR role IS NULL)
  );

-- Users can update only their own contact fields, never their status or role; Admins can update all
CREATE POLICY "profiles_update_policy" ON profiles
  FOR UPDATE TO authenticated
  USING (
    auth.uid() = id OR is_admin_user()
  )
  WITH CHECK (
    is_admin_user()
    OR (
      auth.uid() = id
      AND status = (SELECT status FROM profiles WHERE id = auth.uid())
      AND role = (SELECT role FROM profiles WHERE id = auth.uid())
    )
  );

CREATE POLICY "profiles_delete_policy" ON profiles
  FOR DELETE TO authenticated
  USING (is_admin_user());

-- 6. Hardening Transport Manifests Policies
DROP POLICY IF EXISTS "anon_delete_manifests" ON transport_manifests;
CREATE POLICY "manifests_admin_delete" ON transport_manifests
  FOR DELETE TO authenticated
  USING (is_admin_user());

-- 7. Hardening Cancellation Ledger Policies
DROP POLICY IF EXISTS "anon_delete_ledger" ON cancellation_ledger;
CREATE POLICY "ledger_admin_delete" ON cancellation_ledger
  FOR DELETE TO authenticated
  USING (is_admin_user());

-- 8. Hardening Sponsorship Audits Policies
DROP POLICY IF EXISTS "anon_delete_sponsorships" ON sponsorship_audits;
CREATE POLICY "sponsorships_admin_delete" ON sponsorship_audits
  FOR DELETE TO authenticated
  USING (is_admin_user());

DROP POLICY IF EXISTS "anon_update_sponsorships" ON sponsorship_audits;
CREATE POLICY "sponsorships_update_policy" ON sponsorship_audits
  FOR UPDATE TO authenticated
  USING (is_approved_user() OR is_admin_user())
  WITH CHECK (is_approved_user() OR is_admin_user());

-- 9. Hardening Rehearsal Templates Policies
DROP POLICY IF EXISTS "rehearsal_templates_admin_delete" ON rehearsal_templates;
CREATE POLICY "rehearsal_templates_admin_delete" ON rehearsal_templates
  FOR DELETE TO authenticated
  USING (is_admin_user());

-- 10. Audit Logs Policies
CREATE POLICY "audit_logs_select" ON admin_audit_logs
  FOR SELECT TO authenticated
  USING (is_admin_user());
