-- Apply in staging and verify with two independent rep devices before production.
-- The revocation secret never appears in SELECT results or realtime payloads.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS public.cross_taxi_sponsorships (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 manifest_key text NOT NULL,
 target_manifest_key text NOT NULL,
 payer_passenger_id text,
 payer_name text NOT NULL,
 source_vehicle_id text NOT NULL,
 source_vehicle_name text NOT NULL,
 recipient_passenger_id text NOT NULL,
 recipient_name text NOT NULL,
 target_vehicle_id text NOT NULL,
 target_vehicle_name text NOT NULL,
 amount numeric NOT NULL CHECK (amount > 0 AND amount <= 10000),
 note text,
 revocation_hash text NOT NULL,
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
 created_at timestamptz NOT NULL DEFAULT now(),
 revoked_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS cross_taxi_active_recipient_idx
 ON public.cross_taxi_sponsorships(target_manifest_key, recipient_passenger_id)
 WHERE status = 'active';
CREATE INDEX IF NOT EXISTS cross_taxi_lookup_idx ON public.cross_taxi_sponsorships(target_manifest_key,status);
ALTER TABLE public.cross_taxi_sponsorships ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cross_taxi_sponsorships FROM anon,authenticated;
GRANT SELECT (id,manifest_key,target_manifest_key,payer_passenger_id,payer_name,
source_vehicle_id,source_vehicle_name,recipient_passenger_id,recipient_name,target_vehicle_id,
target_vehicle_name,amount,note,status,created_at,revoked_at)
 ON public.cross_taxi_sponsorships TO anon,authenticated;
DROP POLICY IF EXISTS cross_taxi_read ON public.cross_taxi_sponsorships;
CREATE POLICY cross_taxi_read ON public.cross_taxi_sponsorships FOR SELECT TO anon,authenticated USING (true);
-- Keep the revocation_hash inaccessible: callers only receive public columns through the view.

-- PostgREST select requests must specify columns excluding secret.
CREATE OR REPLACE FUNCTION public.create_cross_taxi_sponsorship(
 p_manifest_key text,p_target_manifest_key text,p_payer_passenger_id text,p_payer_name text,
 p_source_vehicle_id text,p_source_vehicle_name text,p_recipient_passenger_id text,
 p_recipient_name text,p_target_vehicle_id text,p_target_vehicle_name text,p_amount numeric,p_note text,p_secret text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id uuid;
BEGIN
 IF length(trim(coalesce(p_secret,''))) < 32 OR length(trim(coalesce(p_recipient_passenger_id,''))) < 1
 OR length(trim(coalesce(p_target_manifest_key,''))) < 5 OR length(trim(coalesce(p_source_vehicle_id,''))) < 1
 OR length(trim(coalesce(p_target_vehicle_id,''))) < 1 OR length(trim(coalesce(p_payer_name,''))) < 1
 OR length(trim(coalesce(p_recipient_name,''))) < 1 OR p_amount <= 0 OR p_amount > 10000 THEN
  RAISE EXCEPTION 'Invalid sponsorship'; END IF;
 IF p_manifest_key <> p_target_manifest_key THEN
   RAISE EXCEPTION 'Cross-service sponsorship requires administrative review'; END IF;
 -- Validate recipient is actually in the saved target manifest/vehicle. No arbitrary charges.
 IF NOT EXISTS (
  SELECT 1 FROM public.transport_manifests m,
  LATERAL jsonb_array_elements(m.vehicles::jsonb) v
  WHERE m.date = p_target_manifest_key
   AND v->>'id' = p_target_vehicle_id
   AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(COALESCE(v->'riders','[]'::jsonb)) rid
              WHERE rid.value = p_recipient_passenger_id)
 ) THEN RAISE EXCEPTION 'Recipient not assigned to target vehicle'; END IF;
 INSERT INTO public.cross_taxi_sponsorships(manifest_key,target_manifest_key,payer_passenger_id,payer_name,
 source_vehicle_id,source_vehicle_name,recipient_passenger_id,recipient_name,target_vehicle_id,target_vehicle_name,
 amount,note,revocation_hash)
 VALUES(p_manifest_key,p_target_manifest_key,p_payer_passenger_id,p_payer_name,p_source_vehicle_id,p_source_vehicle_name,
 p_recipient_passenger_id,p_recipient_name,p_target_vehicle_id,p_target_vehicle_name,p_amount,p_note,
 encode(extensions.digest(p_secret,'sha256'),'hex')) RETURNING id INTO v_id;
 RETURN v_id;
END $$;
CREATE OR REPLACE FUNCTION public.revoke_cross_taxi_sponsorship(p_id uuid,p_secret text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_updated integer;
BEGIN
 UPDATE public.cross_taxi_sponsorships SET status='revoked',revoked_at=now()
 WHERE id=p_id AND status='active'
 AND revocation_hash=encode(extensions.digest(coalesce(p_secret,''),'sha256'),'hex');
 GET DIAGNOSTICS v_updated=ROW_COUNT;
 IF v_updated <> 1 THEN RAISE EXCEPTION 'Invalid originating-rep revocation authorization'; END IF;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.create_cross_taxi_sponsorship(text,text,text,text,text,text,text,text,text,text,numeric,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.revoke_cross_taxi_sponsorship(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_cross_taxi_sponsorship(text,text,text,text,text,text,text,text,text,text,numeric,text,text) TO anon,authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_cross_taxi_sponsorship(uuid,text) TO anon,authenticated;
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.cross_taxi_sponsorships;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
