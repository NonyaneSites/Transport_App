-- ============================================================================
-- Migration: 20261021160000_rep_live_sync_atomic_rpcs.sql
-- Description: Conflict-safe atomic per-vehicle draft updates and Realtime publication
--              guarantees for live rep-to-rep manifest synchronization.
-- ============================================================================

-- 1. Ensure publication includes transport_manifests with REPLICA IDENTITY FULL
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables 
      WHERE pubname = 'supabase_realtime' AND tablename = 'transport_manifests'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE transport_manifests;
    END IF;
  END IF;
END $$;

ALTER TABLE transport_manifests REPLICA IDENTITY FULL;

-- 2. Atomic per-vehicle draft update function
-- Updates ONLY the specific vehicle within the JSONB array under FOR UPDATE lock.
-- Concurrently editing Rep A (Taxi 1) and Rep B (Taxi 2) will never overwrite each other.
CREATE OR REPLACE FUNCTION rep_update_vehicle_draft(
  p_manifest_key text,
  p_vehicle_id text,
  p_draft_state jsonb,
  p_rep_name text DEFAULT NULL,
  p_license_plate text DEFAULT NULL
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
BEGIN
  IF p_manifest_key IS NULL OR trim(p_manifest_key) = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Manifest key cannot be empty');
  END IF;
  IF p_vehicle_id IS NULL OR trim(p_vehicle_id) = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Vehicle ID cannot be empty');
  END IF;

  -- Lock row exclusively during modification
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
      v_new_vehicles := v_new_vehicles || jsonb_build_array(
        v_elem || jsonb_build_object(
          'draftState', COALESCE(p_draft_state, v_elem->'draftState'),
          'repName', COALESCE(NULLIF(trim(p_rep_name), ''), v_elem->>'repName'),
          'licensePlate', COALESCE(NULLIF(trim(p_license_plate), ''), v_elem->>'licensePlate')
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

  RETURN jsonb_build_object(
    'success', true,
    'date', p_manifest_key,
    'vehicle_id', p_vehicle_id,
    'updated_at', v_now
  );
END;
$$;

GRANT EXECUTE ON FUNCTION rep_update_vehicle_draft(text, text, jsonb, text, text) TO anon, authenticated;
