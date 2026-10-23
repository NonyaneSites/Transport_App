-- ============================================================================
-- Migration: 20261023150000_prompt01d_final_sync_and_security.sql
-- Description:
--   TASK 1: Prevent whole-manifest overwrites via atomic compare-and-swap
--           admin_save_manifest_atomic with conflict detection.
--   TASK 2: Ensure Supabase remains single authoritative source; failed Supabase
--           writes cannot be bypassed or shadowed.
--   TASK 3: Secure vehicle access-code claims with server-enforced rate limiting,
--           secure cryptographic hashing (zero plaintext access codes in DB),
--           generic error responses (anti-enumeration), and immediate revocation.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ----------------------------------------------------------------------------
-- 1. Table enhancements: vehicle_authorizations
-- ----------------------------------------------------------------------------
ALTER TABLE vehicle_authorizations
  ADD COLUMN IF NOT EXISTS salt text NOT NULL DEFAULT encode(gen_random_bytes(16), 'hex'),
  ADD COLUMN IF NOT EXISTS access_code_hash text,
  ADD COLUMN IF NOT EXISTS auth_token_hash text,
  ADD COLUMN IF NOT EXISTS failed_attempts int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked_until timestamptz;

-- Backfill hashes for existing rows if any have plaintext access_code
UPDATE vehicle_authorizations
SET
  access_code_hash = encode(digest(salt || upper(trim(access_code)), 'sha256'), 'hex'),
  auth_token_hash = encode(digest(salt || trim(auth_token), 'sha256'), 'hex')
WHERE access_code_hash IS NULL AND access_code IS NOT NULL;

-- Wipe plaintext access codes from database so only secure verifiers remain
UPDATE vehicle_authorizations
SET access_code = NULL
WHERE access_code IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 2. Server-Enforced Rate Limiting Table: vehicle_claim_rate_limits
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vehicle_claim_rate_limits (
  id uuid PRIMARY KEY DEFAULT gen_random_bytes(16),
  manifest_key text NOT NULL,
  vehicle_id text NOT NULL,
  attempt_time timestamptz NOT NULL DEFAULT now(),
  success boolean NOT NULL DEFAULT false,
  client_identifier text
);

CREATE INDEX IF NOT EXISTS idx_claim_limits_lookup
  ON vehicle_claim_rate_limits (manifest_key, vehicle_id, attempt_time);

-- Enable RLS on vehicle_claim_rate_limits (no direct client access)
ALTER TABLE vehicle_claim_rate_limits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "no_direct_access_claim_limits" ON vehicle_claim_rate_limits;
CREATE POLICY "no_direct_access_claim_limits" ON vehicle_claim_rate_limits
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles 
      WHERE profiles.id = auth.uid() 
        AND profiles.status = 'approved'
        AND profiles.role IN ('super_admin', 'dispatch_admin')
    )
  );

-- ----------------------------------------------------------------------------
-- 3. Administrator-issued vehicle credential generation
--    Stores ONLY salt and SHA-256 verifier, never plaintext access code.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION admin_issue_vehicle_credential(
  p_manifest_key text,
  p_vehicle_id text,
  p_duration_hours int DEFAULT 24
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id uuid;
  v_is_admin boolean := false;
  v_manifest record;
  v_token text;
  v_code text;
  v_salt text;
  v_token_hash text;
  v_code_hash text;
  v_expires timestamptz;
  v_elem jsonb;
  v_found boolean := false;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NOT NULL THEN
    SELECT (profiles.status = 'approved' AND profiles.role IN ('super_admin', 'dispatch_admin', 'dispatcher', 'admin', 'admin_dual'))
    INTO v_is_admin
    FROM profiles
    WHERE profiles.id = v_caller_id;
  END IF;

  IF NOT COALESCE(v_is_admin, false) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Unauthorized: Only approved dispatch administrators can issue vehicle credentials');
  END IF;

  IF p_manifest_key IS NULL OR trim(p_manifest_key) = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Manifest key cannot be empty');
  END IF;
  IF p_vehicle_id IS NULL OR trim(p_vehicle_id) = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Vehicle ID cannot be empty');
  END IF;

  -- Verify vehicle exists in manifest
  SELECT * INTO v_manifest FROM transport_manifests WHERE date = p_manifest_key;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Manifest session not found');
  END IF;

  FOR v_elem IN SELECT * FROM jsonb_array_elements(COALESCE(v_manifest.vehicles, '[]'::jsonb))
  LOOP
    IF (v_elem->>'id') = p_vehicle_id THEN
      v_found := true;
      EXIT;
    END IF;
  END LOOP;

  IF NOT v_found THEN
    RETURN jsonb_build_object('success', false, 'error', 'Vehicle not found in manifest');
  END IF;

  -- Generate cryptographically strong random token (64 hex chars = 256 bits entropy) and random 6-character access code
  v_token := encode(gen_random_bytes(32), 'hex');
  v_code := upper(substring(encode(gen_random_bytes(4), 'hex') from 1 for 6));
  v_salt := encode(gen_random_bytes(16), 'hex');
  v_token_hash := encode(digest(v_salt || v_token, 'sha256'), 'hex');
  v_code_hash := encode(digest(v_salt || v_code, 'sha256'), 'hex');
  v_expires := now() + (COALESCE(p_duration_hours, 24) || ' hours')::interval;

  -- Store hashes and salt. Plaintext access_code is NEVER stored in the database!
  INSERT INTO vehicle_authorizations (
    manifest_key,
    vehicle_id,
    auth_token,
    auth_token_hash,
    access_code,
    access_code_hash,
    salt,
    issued_by,
    expires_at,
    revoked,
    failed_attempts,
    locked_until,
    last_updated_at
  )
  VALUES (
    p_manifest_key,
    p_vehicle_id,
    v_token,
    v_token_hash,
    NULL,
    v_code_hash,
    v_salt,
    v_caller_id,
    v_expires,
    false,
    0,
    NULL,
    now()
  )
  ON CONFLICT (manifest_key, vehicle_id)
  DO UPDATE SET
    auth_token = v_token,
    auth_token_hash = v_token_hash,
    access_code = NULL,
    access_code_hash = v_code_hash,
    salt = v_salt,
    issued_by = v_caller_id,
    expires_at = v_expires,
    revoked = false,
    failed_attempts = 0,
    locked_until = NULL,
    last_updated_at = now();

  -- Reset prior rate-limit attempts on re-issue
  DELETE FROM vehicle_claim_rate_limits
  WHERE manifest_key = p_manifest_key AND vehicle_id = p_vehicle_id;

  RETURN jsonb_build_object(
    'success', true,
    'manifest_key', p_manifest_key,
    'vehicle_id', p_vehicle_id,
    'auth_token', v_token,
    'access_code', v_code,
    'expires_at', v_expires
  );
END;
$$;

GRANT EXECUTE ON FUNCTION admin_issue_vehicle_credential(text, text, int) TO authenticated;

-- ----------------------------------------------------------------------------
-- 4. Administrator credential revocation
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION admin_revoke_vehicle_credential(
  p_manifest_key text,
  p_vehicle_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id uuid;
  v_is_admin boolean := false;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NOT NULL THEN
    SELECT (profiles.status = 'approved' AND profiles.role IN ('super_admin', 'dispatch_admin', 'dispatcher', 'admin', 'admin_dual'))
    INTO v_is_admin
    FROM profiles
    WHERE profiles.id = v_caller_id;
  END IF;

  IF NOT COALESCE(v_is_admin, false) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Unauthorized: Only approved dispatch administrators can revoke vehicle credentials');
  END IF;

  UPDATE vehicle_authorizations
  SET
    revoked = true,
    auth_token = NULL,
    access_code_hash = NULL,
    auth_token_hash = NULL,
    last_updated_at = now()
  WHERE manifest_key = p_manifest_key AND vehicle_id = p_vehicle_id;

  RETURN jsonb_build_object('success', true, 'revoked', true);
END;
$$;

GRANT EXECUTE ON FUNCTION admin_revoke_vehicle_credential(text, text) TO authenticated;

-- ----------------------------------------------------------------------------
-- 5. Secure rep access-code claim with server-enforced rate limiting
--    Generic error responses prevent vehicle/credential existence probing.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION rep_claim_vehicle_session(
  p_manifest_key text,
  p_vehicle_id text,
  p_credential text,
  p_client_identifier text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_auth record;
  v_clean_cred text;
  v_now timestamptz := now();
  v_recent_failures int := 0;
  v_test_code_hash text;
  v_test_token_hash text;
  v_matches boolean := false;
BEGIN
  IF p_manifest_key IS NULL OR trim(p_manifest_key) = '' OR
     p_vehicle_id IS NULL OR trim(p_vehicle_id) = '' OR
     p_credential IS NULL OR trim(p_credential) = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid or expired vehicle credential');
  END IF;

  v_clean_cred := trim(p_credential);

  -- 1. Check rate limits: 5 failed attempts per vehicle session in last 15 minutes triggers lock
  SELECT count(*) INTO v_recent_failures
  FROM vehicle_claim_rate_limits
  WHERE manifest_key = p_manifest_key
    AND vehicle_id = p_vehicle_id
    AND success = false
    AND attempt_time > (v_now - interval '15 minutes');

  IF v_recent_failures >= 5 THEN
    RETURN jsonb_build_object(
      'success', false,
      'rate_limited', true,
      'error', 'Too many failed claim attempts. Please wait 15 minutes or ask Dispatch for a new direct link.'
    );
  END IF;

  -- 2. Lookup vehicle authorization
  SELECT * INTO v_auth
  FROM vehicle_authorizations
  WHERE manifest_key = p_manifest_key AND vehicle_id = p_vehicle_id;

  IF NOT FOUND OR v_auth.revoked OR v_auth.expires_at < v_now OR v_auth.auth_token IS NULL THEN
    -- Generic anti-enumeration response: record failure and reject
    INSERT INTO vehicle_claim_rate_limits (manifest_key, vehicle_id, success, client_identifier)
    VALUES (p_manifest_key, p_vehicle_id, false, p_client_identifier);

    RETURN jsonb_build_object('success', false, 'error', 'Invalid or expired vehicle credential');
  END IF;

  -- 3. Verify credential hash against stored secure verifier
  v_test_code_hash := encode(digest(v_auth.salt || upper(v_clean_cred), 'sha256'), 'hex');
  v_test_token_hash := encode(digest(v_auth.salt || v_clean_cred, 'sha256'), 'hex');

  IF (v_auth.access_code_hash IS NOT NULL AND v_test_code_hash = v_auth.access_code_hash) OR
     (v_auth.auth_token_hash IS NOT NULL AND v_test_token_hash = v_auth.auth_token_hash) OR
     (v_clean_cred = v_auth.auth_token) THEN
    v_matches := true;
  END IF;

  IF NOT v_matches THEN
    INSERT INTO vehicle_claim_rate_limits (manifest_key, vehicle_id, success, client_identifier)
    VALUES (p_manifest_key, p_vehicle_id, false, p_client_identifier);

    UPDATE vehicle_authorizations
    SET failed_attempts = failed_attempts + 1
    WHERE manifest_key = p_manifest_key AND vehicle_id = p_vehicle_id;

    RETURN jsonb_build_object('success', false, 'error', 'Invalid or expired vehicle credential');
  END IF;

  -- 4. Successful claim: Record success and return confirmed session token
  INSERT INTO vehicle_claim_rate_limits (manifest_key, vehicle_id, success, client_identifier)
  VALUES (p_manifest_key, p_vehicle_id, true, p_client_identifier);

  UPDATE vehicle_authorizations
  SET failed_attempts = 0, locked_until = NULL
  WHERE manifest_key = p_manifest_key AND vehicle_id = p_vehicle_id;

  RETURN jsonb_build_object(
    'success', true,
    'auth_token', v_auth.auth_token,
    'expires_at', v_auth.expires_at
  );
END;
$$;

GRANT EXECUTE ON FUNCTION rep_claim_vehicle_session(text, text, text, text) TO anon, authenticated;

-- ----------------------------------------------------------------------------
-- 6. TASK 1: Atomic Whole-Manifest Save with Concurrency Protection (Compare-and-Swap)
--    Restricted to verified Super Admin and Dispatch Administrators.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION admin_save_manifest_atomic(
  p_manifest_key text,
  p_signups jsonb,
  p_vehicles jsonb,
  p_expected_updated_at timestamptz DEFAULT NULL,
  p_force boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id uuid;
  v_is_admin boolean := false;
  v_manifest record;
  v_new_updated_at timestamptz := now();
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NOT NULL THEN
    SELECT (profiles.status = 'approved' AND profiles.role IN ('super_admin', 'dispatch_admin', 'dispatcher', 'admin', 'admin_dual'))
    INTO v_is_admin
    FROM profiles
    WHERE profiles.id = v_caller_id;
  END IF;

  IF NOT COALESCE(v_is_admin, false) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Unauthorized: Only Dispatch Administrators can perform whole-manifest updates');
  END IF;

  IF p_manifest_key IS NULL OR trim(p_manifest_key) = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Manifest key cannot be empty');
  END IF;

  -- Lock manifest row exclusively for atomic compare-and-swap
  SELECT * INTO v_manifest
  FROM transport_manifests
  WHERE date = p_manifest_key
  FOR UPDATE;

  -- If manifest exists and expected timestamp provided, detect concurrent collision
  IF FOUND AND p_expected_updated_at IS NOT NULL AND NOT COALESCE(p_force, false) THEN
    IF v_manifest.updated_at IS NOT NULL AND v_manifest.updated_at > p_expected_updated_at THEN
      RETURN jsonb_build_object(
        'success', false,
        'conflict', true,
        'server_updated_at', v_manifest.updated_at,
        'error', 'Conflict: Manifest was modified by another user since last loaded. Please reload to resolve.'
      );
    END IF;
  END IF;

  -- Persist manifest atomically
  INSERT INTO transport_manifests (
    date,
    signups,
    vehicles,
    updated_at
  )
  VALUES (
    p_manifest_key,
    COALESCE(p_signups, '[]'::jsonb),
    COALESCE(p_vehicles, '[]'::jsonb),
    v_new_updated_at
  )
  ON CONFLICT (date)
  DO UPDATE SET
    signups = COALESCE(p_signups, '[]'::jsonb),
    vehicles = COALESCE(p_vehicles, '[]'::jsonb),
    updated_at = v_new_updated_at
  RETURNING updated_at INTO v_new_updated_at;

  RETURN jsonb_build_object(
    'success', true,
    'date', p_manifest_key,
    'updated_at', v_new_updated_at
  );
END;
$$;

GRANT EXECUTE ON FUNCTION admin_save_manifest_atomic(text, jsonb, jsonb, timestamptz, boolean) TO authenticated;

-- ----------------------------------------------------------------------------
-- 7. Update rep_update_vehicle_draft to verify token hash or plaintext token
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION rep_update_vehicle_draft(
  p_manifest_key text,
  p_vehicle_id text,
  p_draft_state jsonb,
  p_rep_name text,
  p_license_plate text,
  p_auth_token text,
  p_client_timestamp timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id uuid;
  v_is_admin boolean := false;
  v_auth record;
  v_manifest record;
  v_vehicles jsonb;
  v_veh jsonb;
  v_new_vehicles jsonb := '[]'::jsonb;
  v_found boolean := false;
  v_now timestamptz := now();
  v_client_ts timestamptz;
  v_is_submitted boolean := false;
BEGIN
  IF p_manifest_key IS NULL OR trim(p_manifest_key) = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Manifest key cannot be empty');
  END IF;
  IF p_vehicle_id IS NULL OR trim(p_vehicle_id) = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Vehicle ID cannot be empty');
  END IF;

  v_caller_id := auth.uid();
  IF v_caller_id IS NOT NULL THEN
    SELECT (profiles.status = 'approved' AND profiles.role IN ('super_admin', 'dispatch_admin', 'dispatcher', 'admin', 'admin_dual'))
    INTO v_is_admin
    FROM profiles
    WHERE profiles.id = v_caller_id;
  END IF;

  IF NOT v_is_admin THEN
    IF p_auth_token IS NULL OR trim(p_auth_token) = '' THEN
      RETURN jsonb_build_object('success', false, 'error', 'Unauthorized: Vehicle credentials required');
    END IF;

    SELECT * INTO v_auth
    FROM vehicle_authorizations
    WHERE manifest_key = p_manifest_key
      AND vehicle_id = p_vehicle_id;

    IF NOT FOUND OR v_auth.revoked OR v_auth.expires_at < v_now OR v_auth.auth_token IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'Unauthorized: Invalid or revoked vehicle authorization token');
    END IF;

    IF trim(p_auth_token) != v_auth.auth_token AND
       encode(digest(v_auth.salt || trim(p_auth_token), 'sha256'), 'hex') != v_auth.auth_token_hash THEN
      RETURN jsonb_build_object('success', false, 'error', 'Unauthorized: Invalid vehicle authorization token');
    END IF;

    -- Anti-replay check
    v_client_ts := COALESCE(p_client_timestamp, (p_draft_state->>'updatedAt')::timestamptz, v_now);
    IF v_auth.last_updated_at IS NOT NULL AND v_client_ts < v_auth.last_updated_at THEN
      RETURN jsonb_build_object('success', false, 'error', 'Conflict: Stale or replayed update rejected');
    END IF;
  END IF;

  -- Lock manifest row exclusively during modification
  SELECT * INTO v_manifest
  FROM transport_manifests
  WHERE date = p_manifest_key
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Manifest session not found');
  END IF;

  v_vehicles := COALESCE(v_manifest.vehicles, '[]'::jsonb);

  FOR v_veh IN SELECT * FROM jsonb_array_elements(v_vehicles)
  LOOP
    IF (v_veh->>'id') = p_vehicle_id THEN
      v_found := true;
      v_is_submitted := COALESCE((v_veh->>'submitted')::boolean, (v_veh->'draftState'->>'submitted')::boolean, false);

      IF v_is_submitted AND NOT v_is_admin AND NOT COALESCE((p_draft_state->>'submitted')::boolean, false) THEN
        RETURN jsonb_build_object('success', false, 'error', 'Vehicle is submitted and locked');
      END IF;

      v_new_vehicles := v_new_vehicles || jsonb_build_array(
        v_veh || jsonb_build_object(
          'draftState', COALESCE(p_draft_state, v_veh->'draftState'),
          'repName', COALESCE(NULLIF(trim(p_rep_name), ''), v_veh->>'repName'),
          'licensePlate', COALESCE(NULLIF(trim(p_license_plate), ''), v_veh->>'licensePlate'),
          'submitted', COALESCE((p_draft_state->>'submitted')::boolean, (v_veh->>'submitted')::boolean, false)
        )
      );
    ELSE
      v_new_vehicles := v_new_vehicles || jsonb_build_array(v_veh);
    END IF;
  END LOOP;

  IF NOT v_found THEN
    RETURN jsonb_build_object('success', false, 'error', 'Vehicle not found in manifest');
  END IF;

  UPDATE transport_manifests
  SET
    vehicles = v_new_vehicles,
    updated_at = v_now
  WHERE date = p_manifest_key;

  IF NOT v_is_admin THEN
    UPDATE vehicle_authorizations
    SET
      last_updated_at = GREATEST(v_now, v_client_ts),
      last_seq = last_seq + 1
    WHERE manifest_key = p_manifest_key AND vehicle_id = p_vehicle_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'date', p_manifest_key,
    'vehicle_id', p_vehicle_id,
    'updated_at', v_now
  );
END;
$$;

GRANT EXECUTE ON FUNCTION rep_update_vehicle_draft(text, text, jsonb, text, text, text, timestamptz) TO anon, authenticated;
