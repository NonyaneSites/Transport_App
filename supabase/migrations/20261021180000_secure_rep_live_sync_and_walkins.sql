-- ============================================================================
-- Migration: 20261021180000_secure_rep_live_sync_and_walkins.sql
-- Description: 
--   1. Restricts direct table writes on transport_manifests to authenticated admins.
--   2. Introduces vehicle_authorizations table for vehicle-scoped rep authorization.
--   3. Adds rep_get_or_create_vehicle_session RPC to authorize account-free reps.
--   4. Hardens rep_update_vehicle_draft with vehicle-scoped authorization and anti-replay.
--   5. Introduces rep_add_walk_in for atomic walk-in additions without manifest rewriting.
-- ============================================================================

-- 1. Table for vehicle-scoped authorization tokens
CREATE TABLE IF NOT EXISTS vehicle_authorizations (
  manifest_key text NOT NULL,
  vehicle_id text NOT NULL,
  auth_token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  last_seq bigint NOT NULL DEFAULT 0,
  last_updated_at timestamptz,
  PRIMARY KEY (manifest_key, vehicle_id)
);

CREATE INDEX IF NOT EXISTS idx_vehicle_auth_lookup 
  ON vehicle_authorizations (manifest_key, vehicle_id, auth_token);

ALTER TABLE vehicle_authorizations ENABLE ROW LEVEL SECURITY;

-- Block direct reads by anonymous callers
DROP POLICY IF EXISTS "anon_read_vehicle_auth" ON vehicle_authorizations;
DROP POLICY IF EXISTS "admin_manage_vehicle_auth" ON vehicle_authorizations;

CREATE POLICY "admin_manage_vehicle_auth" ON vehicle_authorizations
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles 
      WHERE profiles.id = auth.uid() 
        AND (profiles.role IN ('admin', 'dispatch') OR profiles.status = 'approved')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles 
      WHERE profiles.id = auth.uid() 
        AND (profiles.role IN ('admin', 'dispatch') OR profiles.status = 'approved')
    )
  );

-- 2. Restrict direct table writes on transport_manifests
DROP POLICY IF EXISTS "anon_insert_manifests" ON transport_manifests;
DROP POLICY IF EXISTS "anon_update_manifests" ON transport_manifests;
DROP POLICY IF EXISTS "anon_delete_manifests" ON transport_manifests;
DROP POLICY IF EXISTS "manifests_admin_write" ON transport_manifests;

CREATE POLICY "manifests_admin_write" ON transport_manifests
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles 
      WHERE profiles.id = auth.uid() 
        AND (profiles.role IN ('admin', 'dispatch') OR profiles.status = 'approved')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles 
      WHERE profiles.id = auth.uid() 
        AND (profiles.role IN ('admin', 'dispatch') OR profiles.status = 'approved')
    )
  );

-- 3. RPC to obtain or initialize a vehicle session authorization token
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
  v_manifest record;
  v_auth record;
  v_token text;
  v_elem jsonb;
  v_found boolean := false;
  v_is_submitted boolean := false;
BEGIN
  IF p_manifest_key IS NULL OR trim(p_manifest_key) = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Manifest key cannot be empty');
  END IF;
  IF p_vehicle_id IS NULL OR trim(p_vehicle_id) = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Vehicle ID cannot be empty');
  END IF;

  -- Verify manifest and vehicle exist
  SELECT * INTO v_manifest
  FROM transport_manifests
  WHERE date = p_manifest_key;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Manifest session not found');
  END IF;

  FOR v_elem IN SELECT * FROM jsonb_array_elements(COALESCE(v_manifest.vehicles, '[]'::jsonb))
  LOOP
    IF (v_elem->>'id') = p_vehicle_id THEN
      v_found := true;
      v_is_submitted := COALESCE((v_elem->>'submitted')::boolean, (v_elem->'draftState'->>'submitted')::boolean, false);
      EXIT;
    END IF;
  END LOOP;

  IF NOT v_found THEN
    RETURN jsonb_build_object('success', false, 'error', 'Vehicle not found in manifest');
  END IF;

  IF v_is_submitted THEN
    RETURN jsonb_build_object('success', false, 'error', 'Vehicle has already been submitted and locked');
  END IF;

  -- Check for existing active token
  SELECT * INTO v_auth
  FROM vehicle_authorizations
  WHERE manifest_key = p_manifest_key AND vehicle_id = p_vehicle_id;

  IF FOUND AND v_auth.expires_at > now() THEN
    RETURN jsonb_build_object(
      'success', true,
      'auth_token', v_auth.auth_token,
      'expires_at', v_auth.expires_at
    );
  END IF;

  -- Generate secure random 32-character token
  v_token := encode(gen_random_bytes(16), 'hex');

  INSERT INTO vehicle_authorizations (manifest_key, vehicle_id, auth_token, expires_at)
  VALUES (p_manifest_key, p_vehicle_id, v_token, now() + interval '24 hours')
  ON CONFLICT (manifest_key, vehicle_id)
  DO UPDATE SET
    auth_token = v_token,
    expires_at = now() + interval '24 hours',
    last_updated_at = now();

  RETURN jsonb_build_object(
    'success', true,
    'auth_token', v_token,
    'expires_at', (now() + interval '24 hours')
  );
END;
$$;

GRANT EXECUTE ON FUNCTION rep_get_or_create_vehicle_session(text, text) TO anon, authenticated;

-- 4. Secure atomic per-vehicle draft update with vehicle-scoped authorization
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
  v_elem jsonb;
  v_found boolean := false;
  v_now timestamptz := now();
  v_auth record;
  v_client_ts timestamptz;
  v_is_submitted boolean := false;
  v_is_admin boolean := false;
BEGIN
  IF p_manifest_key IS NULL OR trim(p_manifest_key) = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Manifest key cannot be empty');
  END IF;
  IF p_vehicle_id IS NULL OR trim(p_vehicle_id) = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Vehicle ID cannot be empty');
  END IF;

  -- Check admin authorization
  BEGIN
    SELECT (profiles.role IN ('admin', 'dispatch') OR profiles.status = 'approved') INTO v_is_admin
    FROM profiles
    WHERE profiles.id = auth.uid();
  EXCEPTION WHEN OTHERS THEN
    v_is_admin := false;
  END;
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

  FOR v_elem IN SELECT * FROM jsonb_array_elements(v_vehicles)
  LOOP
    IF (v_elem->>'id') = p_vehicle_id THEN
      v_found := true;
      v_is_submitted := COALESCE((v_elem->>'submitted')::boolean, (v_elem->'draftState'->>'submitted')::boolean, false);

      IF v_is_submitted AND NOT v_is_admin AND NOT COALESCE((p_draft_state->>'submitted')::boolean, false) THEN
        RETURN jsonb_build_object('success', false, 'error', 'Vehicle is submitted and locked');
      END IF;

      v_new_vehicles := v_new_vehicles || jsonb_build_array(
        v_elem || jsonb_build_object(
          'draftState', COALESCE(p_draft_state, v_elem->'draftState'),
          'repName', COALESCE(NULLIF(trim(p_rep_name), ''), v_elem->>'repName'),
          'licensePlate', COALESCE(NULLIF(trim(p_license_plate), ''), v_elem->>'licensePlate'),
          'submitted', COALESCE((p_draft_state->>'submitted')::boolean, (v_elem->>'submitted')::boolean, false)
        )
      );
    ELSE
      v_new_vehicles := v_new_vehicles || jsonb_build_array(v_elem);
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
      last_updated_at = v_now,
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

-- 5. Atomic walk-in passenger addition and vehicle assignment
CREATE OR REPLACE FUNCTION rep_add_walk_in(
  p_manifest_key text,
  p_vehicle_id text,
  p_passenger jsonb,
  p_draft_update jsonb DEFAULT NULL,
  p_auth_token text DEFAULT NULL
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
  v_elem jsonb;
  v_found_vehicle boolean := false;
  v_existing_signup_index int := -1;
  v_passenger_id text;
  v_now timestamptz := now();
  v_is_admin boolean := false;
  v_auth record;
  v_riders jsonb;
  v_clean_riders jsonb;
  v_draft jsonb;
  v_present_ids jsonb;
  v_absent_ids jsonb;
  v_target_signup jsonb;
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

  -- Check admin authorization
  BEGIN
    SELECT (profiles.role IN ('admin', 'dispatch') OR profiles.status = 'approved') INTO v_is_admin
    FROM profiles
    WHERE profiles.id = auth.uid();
  EXCEPTION WHEN OTHERS THEN
    v_is_admin := false;
  END;
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

  -- Upsert passenger in signups list atomically (preserving payment/sponsorship fields)
  v_target_signup := p_passenger || jsonb_build_object(
    'assignedTo', p_vehicle_id,
    'present', true,
    'walkIn', true
  );

  FOR v_elem IN SELECT * FROM jsonb_array_elements(v_signups)
  LOOP
    IF (v_elem->>'id') = v_passenger_id THEN
      v_new_signups := v_new_signups || jsonb_build_array(v_elem || v_target_signup);
      v_existing_signup_index := 1;
    ELSE
      v_new_signups := v_new_signups || jsonb_build_array(v_elem);
    END IF;
  END LOOP;

  IF v_existing_signup_index = -1 THEN
    v_new_signups := v_new_signups || jsonb_build_array(v_target_signup);
  END IF;

  -- Atomically update vehicles: add passenger to target vehicle, remove from any other vehicle
  FOR v_elem IN SELECT * FROM jsonb_array_elements(v_vehicles)
  LOOP
    IF (v_elem->>'id') = p_vehicle_id THEN
      v_found_vehicle := true;
      v_riders := COALESCE(v_elem->'riders', '[]'::jsonb);
      
      IF NOT (v_riders @> to_jsonb(v_passenger_id)) THEN
        v_riders := v_riders || to_jsonb(v_passenger_id);
      END IF;

      v_draft := COALESCE(v_elem->'draftState', '{}'::jsonb);
      v_present_ids := COALESCE(v_draft->'presentIds', '[]'::jsonb);
      IF NOT (v_present_ids @> to_jsonb(v_passenger_id)) THEN
        v_present_ids := v_present_ids || to_jsonb(v_passenger_id);
      END IF;

      -- Remove from absentIds
      v_absent_ids := '[]'::jsonb;
      FOR v_elem IN SELECT * FROM jsonb_array_elements(COALESCE(v_draft->'absentIds', '[]'::jsonb))
      LOOP
        IF (v_elem #>> '{}') != v_passenger_id THEN
          v_absent_ids := v_absent_ids || jsonb_build_array(v_elem);
        END IF;
      END LOOP;

      v_draft := v_draft || jsonb_build_object(
        'presentIds', v_present_ids,
        'absentIds', v_absent_ids,
        'updatedAt', v_now,
        'repName', COALESCE(NULLIF(trim(p_draft_update->>'repName'), ''), v_draft->>'repName', v_elem->>'repName'),
        'licensePlate', COALESCE(NULLIF(trim(p_draft_update->>'licensePlate'), ''), v_draft->>'licensePlate', v_elem->>'licensePlate')
      );

      v_new_vehicles := v_new_vehicles || jsonb_build_array(
        v_elem || jsonb_build_object(
          'riders', v_riders,
          'draftState', v_draft,
          'repName', COALESCE(NULLIF(trim(p_draft_update->>'repName'), ''), v_elem->>'repName'),
          'licensePlate', COALESCE(NULLIF(trim(p_draft_update->>'licensePlate'), ''), v_elem->>'licensePlate')
        )
      );
    ELSE
      -- Cleanly remove passenger from any previous vehicle
      v_riders := COALESCE(v_elem->'riders', '[]'::jsonb);
      v_clean_riders := '[]'::jsonb;
      FOR v_elem IN SELECT * FROM jsonb_array_elements(v_riders)
      LOOP
        IF (v_elem #>> '{}') != v_passenger_id THEN
          v_clean_riders := v_clean_riders || jsonb_build_array(v_elem);
        END IF;
      END LOOP;

      v_new_vehicles := v_new_vehicles || jsonb_build_array(
        v_elem || jsonb_build_object('riders', v_clean_riders)
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
    'updated_at', v_now
  );
END;
$$;

GRANT EXECUTE ON FUNCTION rep_add_walk_in(text, text, jsonb, jsonb, text) TO anon, authenticated;
