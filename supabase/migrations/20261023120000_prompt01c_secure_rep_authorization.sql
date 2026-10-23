-- ============================================================================
-- Migration: 20261023120000_prompt01c_secure_rep_authorization.sql
-- Description:
--   1. Fixes administrator authorization across all policies and functions:
--      Removes 'OR profiles.status = approved' loopholes; requires explicit
--      canonical roles ('super_admin', 'dispatch_admin', 'dispatcher', 'admin', 'admin_dual')
--      AND 'status = approved'.
--   2. Revokes and drops the legacy insecure 5-argument rep_update_vehicle_draft.
--   3. Secures vehicle session credential issuance: prevents arbitrary anonymous
--      token generation; requires administrator issuance or verifiable claim credential.
--   4. Adds secure revocation and access code support to vehicle_authorizations.
--   5. Fixes variable shadowing and prevents silent cross-taxi transfers in rep_add_walk_in.
-- ============================================================================

-- 1. Enhance vehicle_authorizations table with access code, issuer, and revocation support
ALTER TABLE vehicle_authorizations
  ADD COLUMN IF NOT EXISTS access_code text,
  ADD COLUMN IF NOT EXISTS issued_by uuid,
  ADD COLUMN IF NOT EXISTS revoked boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_vehicle_auth_access_code
  ON vehicle_authorizations (manifest_key, vehicle_id, access_code);

CREATE INDEX IF NOT EXISTS idx_vehicle_auth_active
  ON vehicle_authorizations (manifest_key, vehicle_id, auth_token, revoked, expires_at);

-- 2. Strictly secure RLS on vehicle_authorizations:
-- Only approved administrators/dispatchers can view or manage authorizations.
-- Anonymous callers have ZERO direct table access.
DROP POLICY IF EXISTS "admin_manage_vehicle_auth" ON vehicle_authorizations;
DROP POLICY IF EXISTS "anon_read_vehicle_auth" ON vehicle_authorizations;

CREATE POLICY "admin_manage_vehicle_auth" ON vehicle_authorizations
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles 
      WHERE profiles.id = auth.uid() 
        AND profiles.status = 'approved'
        AND profiles.role IN ('super_admin', 'dispatch_admin', 'dispatcher', 'admin', 'admin_dual')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles 
      WHERE profiles.id = auth.uid() 
        AND profiles.status = 'approved'
        AND profiles.role IN ('super_admin', 'dispatch_admin', 'dispatcher', 'admin', 'admin_dual')
    )
  );

-- 3. Strictly secure RLS on transport_manifests:
-- Remove any policy allowing status = 'approved' without explicit dispatch role.
DROP POLICY IF EXISTS "manifests_admin_write" ON transport_manifests;
DROP POLICY IF EXISTS "anon_insert_manifests" ON transport_manifests;
DROP POLICY IF EXISTS "anon_update_manifests" ON transport_manifests;
DROP POLICY IF EXISTS "anon_delete_manifests" ON transport_manifests;

CREATE POLICY "manifests_admin_write" ON transport_manifests
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles 
      WHERE profiles.id = auth.uid() 
        AND profiles.status = 'approved'
        AND profiles.role IN ('super_admin', 'dispatch_admin', 'dispatcher', 'admin', 'admin_dual')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles 
      WHERE profiles.id = auth.uid() 
        AND profiles.status = 'approved'
        AND profiles.role IN ('super_admin', 'dispatch_admin', 'dispatcher', 'admin', 'admin_dual')
    )
  );

-- 4. Revoke and Drop legacy insecure 5-argument rep_update_vehicle_draft
-- Prevents clients or attackers from bypassing vehicle token authorization.
REVOKE EXECUTE ON FUNCTION rep_update_vehicle_draft(text, text, jsonb, text, text) FROM public, anon, authenticated;
DROP FUNCTION IF EXISTS rep_update_vehicle_draft(text, text, jsonb, text, text);

-- 5. Administrator-issued vehicle credential generation
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

  -- Generate secure 32-char hex token and 6-char alphanumeric code (e.g. for WhatsApp or direct entry)
  v_token := encode(gen_random_bytes(16), 'hex');
  v_code := upper(substring(encode(gen_random_bytes(4), 'hex') from 1 for 6));
  v_expires := now() + (COALESCE(p_duration_hours, 24) || ' hours')::interval;

  INSERT INTO vehicle_authorizations (manifest_key, vehicle_id, auth_token, access_code, issued_by, expires_at, revoked)
  VALUES (p_manifest_key, p_vehicle_id, v_token, v_code, v_caller_id, v_expires, false)
  ON CONFLICT (manifest_key, vehicle_id)
  DO UPDATE SET
    auth_token = v_token,
    access_code = v_code,
    issued_by = v_caller_id,
    expires_at = v_expires,
    revoked = false,
    last_updated_at = now();

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

-- 6. Administrator revocation of vehicle credentials
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
  SET revoked = true, last_updated_at = now()
  WHERE manifest_key = p_manifest_key AND vehicle_id = p_vehicle_id;

  RETURN jsonb_build_object('success', true, 'revoked', true);
END;
$$;

GRANT EXECUTE ON FUNCTION admin_revoke_vehicle_credential(text, text) TO authenticated;

-- 7. Secure rep session claim: allows reps with an admin-issued credential (token or access code)
-- to obtain/verify their active session without leaking existing tokens to arbitrary callers.
CREATE OR REPLACE FUNCTION rep_claim_vehicle_session(
  p_manifest_key text,
  p_vehicle_id text,
  p_credential text
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
BEGIN
  IF p_manifest_key IS NULL OR trim(p_manifest_key) = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Manifest key cannot be empty');
  END IF;
  IF p_vehicle_id IS NULL OR trim(p_vehicle_id) = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Vehicle ID cannot be empty');
  END IF;
  IF p_credential IS NULL OR trim(p_credential) = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Vehicle credential is required');
  END IF;

  v_clean_cred := trim(p_credential);

  SELECT * INTO v_auth
  FROM vehicle_authorizations
  WHERE manifest_key = p_manifest_key
    AND vehicle_id = p_vehicle_id
    AND (auth_token = v_clean_cred OR access_code = upper(v_clean_cred));

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid vehicle credential');
  END IF;

  IF v_auth.revoked THEN
    RETURN jsonb_build_object('success', false, 'error', 'Vehicle credential has been revoked by Dispatch');
  END IF;

  IF v_auth.expires_at < v_now THEN
    RETURN jsonb_build_object('success', false, 'error', 'Vehicle credential has expired. Request a new link from Dispatch.');
  END IF;

  -- Success: Return confirmed session token
  RETURN jsonb_build_object(
    'success', true,
    'auth_token', v_auth.auth_token,
    'expires_at', v_auth.expires_at
  );
END;
$$;

GRANT EXECUTE ON FUNCTION rep_claim_vehicle_session(text, text, text) TO anon, authenticated;

-- 8. Disarm obsolete rep_get_or_create_vehicle_session:
-- Never hand out tokens to arbitrary unverified callers.
CREATE OR REPLACE FUNCTION rep_get_or_create_vehicle_session(
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

  IF v_is_admin THEN
    RETURN admin_issue_vehicle_credential(p_manifest_key, p_vehicle_id, 24);
  END IF;

  -- Reject arbitrary anonymous token generation
  RETURN jsonb_build_object(
    'success', false,
    'error', 'Unauthorized: Vehicle credentials must be issued by a Dispatch Administrator. Use the WhatsApp link provided by Dispatch or claim your session with a vehicle access code.'
  );
END;
$$;

GRANT EXECUTE ON FUNCTION rep_get_or_create_vehicle_session(text, text) TO anon, authenticated;

-- 9. Hardened rep_update_vehicle_draft with strict role check and anti-replay
CREATE OR REPLACE FUNCTION rep_update_vehicle_draft(
  p_manifest_key text,
  p_vehicle_id text,
  p_draft_state jsonb,
  p_rep_name text DEFAULT NULL,
  p_license_plate text DEFAULT NULL,
  p_auth_token text DEFAULT NULL,
  p_client_timestamp timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_manifest record;
  v_vehicles jsonb;
  v_new_vehicles jsonb := '[]'::jsonb;
  v_veh jsonb;
  v_found boolean := false;
  v_now timestamptz := now();
  v_auth record;
  v_client_ts timestamptz;
  v_is_submitted boolean := false;
  v_caller_id uuid;
  v_is_admin boolean := false;
BEGIN
  IF p_manifest_key IS NULL OR trim(p_manifest_key) = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Manifest key cannot be empty');
  END IF;
  IF p_vehicle_id IS NULL OR trim(p_vehicle_id) = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Vehicle ID cannot be empty');
  END IF;

  -- Strict admin role authorization check: requires approved status AND explicit canonical role
  v_caller_id := auth.uid();
  IF v_caller_id IS NOT NULL THEN
    SELECT (profiles.status = 'approved' AND profiles.role IN ('super_admin', 'dispatch_admin', 'dispatcher', 'admin', 'admin_dual'))
    INTO v_is_admin
    FROM profiles
    WHERE profiles.id = v_caller_id;
  END IF;
  v_is_admin := COALESCE(v_is_admin, false);

  -- For non-admin reps, require valid, unrevoked vehicle-scoped authorization token
  IF NOT v_is_admin THEN
    IF p_auth_token IS NULL OR trim(p_auth_token) = '' THEN
      RETURN jsonb_build_object('success', false, 'error', 'Unauthorized: Missing vehicle authorization token');
    END IF;

    SELECT * INTO v_auth
    FROM vehicle_authorizations
    WHERE manifest_key = p_manifest_key
      AND vehicle_id = p_vehicle_id
      AND auth_token = trim(p_auth_token);

    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'error', 'Unauthorized: Invalid vehicle authorization token');
    END IF;

    IF v_auth.revoked THEN
      RETURN jsonb_build_object('success', false, 'error', 'Unauthorized: Vehicle authorization token has been revoked by Dispatch');
    END IF;

    IF v_auth.expires_at < v_now THEN
      RETURN jsonb_build_object('success', false, 'error', 'Unauthorized: Vehicle authorization token has expired');
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

-- 10. Fixed rep_add_walk_in:
-- Corrects variable shadowing across nested loops, preserves vehicle structures,
-- and prevents silent transfers from other vehicles without explicit confirmation.
CREATE OR REPLACE FUNCTION rep_add_walk_in(
  p_manifest_key text,
  p_vehicle_id text,
  p_passenger jsonb,
  p_draft_update jsonb DEFAULT NULL,
  p_auth_token text DEFAULT NULL,
  p_confirm_transfer boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_manifest record;
  v_signups jsonb;
  v_vehicles jsonb;
  v_new_signups jsonb := '[]'::jsonb;
  v_new_vehicles jsonb := '[]'::jsonb;
  v_veh jsonb;
  v_p_elem jsonb;
  v_inner_elem jsonb;
  v_found_vehicle boolean := false;
  v_passenger_id text;
  v_now timestamptz := now();
  v_caller_id uuid;
  v_is_admin boolean := false;
  v_auth record;
  v_riders jsonb;
  v_clean_riders jsonb;
  v_draft jsonb;
  v_present_ids jsonb;
  v_absent_ids jsonb;
  v_target_signup jsonb;
  v_existing_assigned_veh text := NULL;
  v_existing_found boolean := false;
BEGIN
  IF p_manifest_key IS NULL OR trim(p_manifest_key) = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Manifest key cannot be empty');
  END IF;
  IF p_vehicle_id IS NULL OR trim(p_vehicle_id) = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Vehicle ID cannot be empty');
  END IF;
  IF p_passenger IS NULL OR (p_passenger->>'id') IS NULL OR trim(p_passenger->>'id') = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Passenger ID is required');
  END IF;

  v_passenger_id := trim(p_passenger->>'id');

  -- Strict admin authorization check
  v_caller_id := auth.uid();
  IF v_caller_id IS NOT NULL THEN
    SELECT (profiles.status = 'approved' AND profiles.role IN ('super_admin', 'dispatch_admin', 'dispatcher', 'admin', 'admin_dual'))
    INTO v_is_admin
    FROM profiles
    WHERE profiles.id = v_caller_id;
  END IF;
  v_is_admin := COALESCE(v_is_admin, false);

  -- For non-admin reps, require valid vehicle-scoped authorization token
  IF NOT v_is_admin THEN
    IF p_auth_token IS NULL OR trim(p_auth_token) = '' THEN
      RETURN jsonb_build_object('success', false, 'error', 'Unauthorized: Missing vehicle authorization token');
    END IF;

    SELECT * INTO v_auth
    FROM vehicle_authorizations
    WHERE manifest_key = p_manifest_key
      AND vehicle_id = p_vehicle_id
      AND auth_token = trim(p_auth_token);

    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'error', 'Unauthorized: Invalid vehicle authorization token');
    END IF;

    IF v_auth.revoked THEN
      RETURN jsonb_build_object('success', false, 'error', 'Unauthorized: Vehicle authorization token has been revoked');
    END IF;

    IF v_auth.expires_at < v_now THEN
      RETURN jsonb_build_object('success', false, 'error', 'Unauthorized: Vehicle authorization token has expired');
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

  v_signups := COALESCE(v_manifest.signups, '[]'::jsonb);
  v_vehicles := COALESCE(v_manifest.vehicles, '[]'::jsonb);

  -- Check if passenger exists and is assigned to another vehicle
  FOR v_p_elem IN SELECT * FROM jsonb_array_elements(v_signups)
  LOOP
    IF (v_p_elem->>'id') = v_passenger_id THEN
      v_existing_found := true;
      v_existing_assigned_veh := NULLIF(trim(v_p_elem->>'assignedTo'), '');
      EXIT;
    END IF;
  END LOOP;

  -- Fallback: check if passenger is present in any vehicle's riders list
  IF v_existing_assigned_veh IS NULL THEN
    FOR v_veh IN SELECT * FROM jsonb_array_elements(v_vehicles)
    LOOP
      IF COALESCE(v_veh->'riders', '[]'::jsonb) @> to_jsonb(v_passenger_id) THEN
        v_existing_assigned_veh := v_veh->>'id';
        EXIT;
      END IF;
    END LOOP;
  END IF;

  -- Protection against silent vehicle transfers:
  -- If passenger is already in another vehicle and caller is not an admin, require explicit p_confirm_transfer = true
  IF (v_existing_found OR v_existing_assigned_veh IS NOT NULL) AND v_existing_assigned_veh IS NOT NULL AND v_existing_assigned_veh != p_vehicle_id THEN
    IF NOT v_is_admin AND NOT COALESCE(p_confirm_transfer, false) THEN
      RETURN jsonb_build_object(
        'success', false,
        'requires_confirmation', true,
        'existing_vehicle_id', v_existing_assigned_veh,
        'error', 'Passenger is already assigned to ' || v_existing_assigned_veh || '. Explicit transfer confirmation required.'
      );
    END IF;
  END IF;

  -- Upsert passenger in signups list atomically, preserving existing payment/sponsorship fields
  v_target_signup := p_passenger || jsonb_build_object(
    'assignedTo', p_vehicle_id,
    'present', true,
    'walkIn', true
  );

  FOR v_p_elem IN SELECT * FROM jsonb_array_elements(v_signups)
  LOOP
    IF (v_p_elem->>'id') = v_passenger_id THEN
      v_new_signups := v_new_signups || jsonb_build_array(v_p_elem || v_target_signup);
    ELSE
      v_new_signups := v_new_signups || jsonb_build_array(v_p_elem);
    END IF;
  END LOOP;

  IF NOT v_existing_found THEN
    v_new_signups := v_new_signups || jsonb_build_array(v_target_signup);
  END IF;

  -- Update vehicles with dedicated distinct variables (NO shadowing)
  FOR v_veh IN SELECT * FROM jsonb_array_elements(v_vehicles)
  LOOP
    IF (v_veh->>'id') = p_vehicle_id THEN
      v_found_vehicle := true;
      v_riders := COALESCE(v_veh->'riders', '[]'::jsonb);

      -- Add to riders array if not present
      IF NOT (v_riders @> to_jsonb(v_passenger_id)) THEN
        v_riders := v_riders || to_jsonb(v_passenger_id);
      END IF;

      v_draft := COALESCE(v_veh->'draftState', '{}'::jsonb);
      v_present_ids := COALESCE(v_draft->'presentIds', '[]'::jsonb);
      IF NOT (v_present_ids @> to_jsonb(v_passenger_id)) THEN
        v_present_ids := v_present_ids || to_jsonb(v_passenger_id);
      END IF;

      -- Remove from absentIds using dedicated inner element variable
      v_absent_ids := '[]'::jsonb;
      FOR v_inner_elem IN SELECT * FROM jsonb_array_elements(COALESCE(v_draft->'absentIds', '[]'::jsonb))
      LOOP
        IF (v_inner_elem #>> '{}') != v_passenger_id THEN
          v_absent_ids := v_absent_ids || jsonb_build_array(v_inner_elem);
        END IF;
      END LOOP;

      v_draft := v_draft || jsonb_build_object(
        'presentIds', v_present_ids,
        'absentIds', v_absent_ids,
        'updatedAt', v_now,
        'repName', COALESCE(NULLIF(trim(p_draft_update->>'repName'), ''), v_draft->>'repName', v_veh->>'repName'),
        'licensePlate', COALESCE(NULLIF(trim(p_draft_update->>'licensePlate'), ''), v_draft->>'licensePlate', v_veh->>'licensePlate')
      );

      v_new_vehicles := v_new_vehicles || jsonb_build_array(
        v_veh || jsonb_build_object(
          'riders', v_riders,
          'draftState', v_draft,
          'repName', COALESCE(NULLIF(trim(p_draft_update->>'repName'), ''), v_veh->>'repName'),
          'licensePlate', COALESCE(NULLIF(trim(p_draft_update->>'licensePlate'), ''), v_veh->>'licensePlate')
        )
      );
    ELSE
      -- If passenger was previously assigned to this other vehicle, remove cleanly
      v_riders := COALESCE(v_veh->'riders', '[]'::jsonb);
      v_clean_riders := '[]'::jsonb;
      FOR v_inner_elem IN SELECT * FROM jsonb_array_elements(v_riders)
      LOOP
        IF (v_inner_elem #>> '{}') != v_passenger_id THEN
          v_clean_riders := v_clean_riders || jsonb_build_array(v_inner_elem);
        END IF;
      END LOOP;

      v_new_vehicles := v_new_vehicles || jsonb_build_array(
        v_veh || jsonb_build_object('riders', v_clean_riders)
      );
    END IF;
  END LOOP;

  IF NOT v_found_vehicle THEN
    RETURN jsonb_build_object('success', false, 'error', 'Vehicle not found in manifest');
  END IF;

  UPDATE transport_manifests
  SET
    signups = v_new_signups,
    vehicles = v_new_vehicles,
    updated_at = v_now
  WHERE date = p_manifest_key;

  RETURN jsonb_build_object(
    'success', true,
    'date', p_manifest_key,
    'vehicle_id', p_vehicle_id,
    'passenger_id', v_passenger_id,
    'transferred', (v_existing_found AND v_existing_assigned_veh IS NOT NULL AND v_existing_assigned_veh != p_vehicle_id),
    'updated_at', v_now
  );
END;
$$;

GRANT EXECUTE ON FUNCTION rep_add_walk_in(text, text, jsonb, jsonb, text, boolean) TO anon, authenticated;
