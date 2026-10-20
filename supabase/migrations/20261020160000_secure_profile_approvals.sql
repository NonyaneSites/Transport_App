-- Apply in staging first. Source of truth for admin approvals: public.profiles.
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'rep';
CREATE OR REPLACE FUNCTION public.admin_update_profile_role(
  target_user_id uuid, requested_role text, requested_status text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE caller_role text; caller_status text;
BEGIN
  SELECT role, status INTO caller_role, caller_status
  FROM public.profiles WHERE id = auth.uid();
  IF auth.uid() IS NULL OR caller_role IS DISTINCT FROM 'super_admin'
      OR caller_status IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION 'Super Administrator approval required';
  END IF;
  IF requested_role NOT IN ('rep','dispatch_admin','ledger_admin','super_admin')
    OR requested_status NOT IN ('pending','approved','rejected') THEN
    RAISE EXCEPTION 'Invalid role or status';
  END IF;
  IF target_user_id = auth.uid() AND (requested_role <> 'super_admin' OR requested_status <> 'approved') THEN
    RAISE EXCEPTION 'Cannot revoke own Super Administrator access';
  END IF;
  UPDATE public.profiles SET role = requested_role, status = requested_status
  WHERE id = target_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Target user profile not found'; END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_update_profile_role(uuid,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_update_profile_role(uuid,text,text) TO authenticated;
