/*
# Create transport_manifests table (single-tenant, no auth)

1. New Tables
- `transport_manifests`
- `date` (text, primary key) — composite identifier like `2026-08-16_PM_Normal`
- `signups` (jsonb, default '[]') — array of passenger objects:
    { id, fullName, stop, assignedTo, present, cancellationFeeOwed }
- `vehicles` (jsonb, default '[]') — array of vehicle objects:
    { id, name, type, riders: [passengerId...] }
- `created_at` (timestamptz, default now())
- `updated_at` (timestamptz, default now())

2. Security
- Enable RLS on `transport_manifests`.
- Allow anon + authenticated CRUD because the app is intentionally shared/public
  (transport coordination portal with no sign-in screen).

3. Notes
- `updated_at` is bumped via a trigger on UPDATE to track manifest freshness.
- All passenger/vehicle data lives in JSONB columns so manifests can be saved
  and loaded atomically as a single document per service session.
*/

CREATE TABLE IF NOT EXISTS transport_manifests (
  date text PRIMARY KEY,
  signups jsonb NOT NULL DEFAULT '[]'::jsonb,
  vehicles jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE transport_manifests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_manifests" ON transport_manifests;
CREATE POLICY "anon_select_manifests" ON transport_manifests FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_manifests" ON transport_manifests;
CREATE POLICY "anon_insert_manifests" ON transport_manifests FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_manifests" ON transport_manifests;
CREATE POLICY "anon_update_manifests" ON transport_manifests FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_manifests" ON transport_manifests;
CREATE POLICY "anon_delete_manifests" ON transport_manifests FOR DELETE
  TO anon, authenticated USING (true);

-- updated_at trigger
CREATE OR REPLACE FUNCTION bump_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS transport_manifests_updated_at ON transport_manifests;
CREATE TRIGGER transport_manifests_updated_at
  BEFORE UPDATE ON transport_manifests
  FOR EACH ROW
  EXECUTE FUNCTION bump_updated_at();
