/*
# Create fleet_vehicles table in Supabase

1. New Table: `fleet_vehicles`
   - `id` (uuid, primary key)
   - `name` (text, not null) — e.g. "Toyota Quantum 1", "Soweto Bus A"
   - `type` (text, not null) — 'Bus' or 'Taxi'
   - `capacity` (integer, not null) — seating capacity (e.g. 15 for Taxi, 60 for Bus)
   - `license_plate` (text) — registration plate number
   - `driver_name` (text) — primary driver name
   - `driver_phone` (text) — driver contact number
   - `default_rep` (text) — default assigned transport representative
   - `default_stop` (text) — primary route hub or pickup location
   - `notes` (text) — dispatch/vehicle notes
   - `is_active` (boolean, default true) — active in fleet
   - `created_at` (timestamptz, default now())
   - `updated_at` (timestamptz, default now())

2. Security:
   - Enable RLS on `fleet_vehicles`.
   - Allow anon and authenticated SELECT, INSERT, UPDATE, DELETE to support church transport coordination.

3. Trigger:
   - Auto-bump updated_at on modification.
*/

CREATE TABLE IF NOT EXISTS fleet_vehicles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  type text NOT NULL CHECK (type IN ('Bus', 'Taxi')),
  capacity integer NOT NULL DEFAULT 15,
  license_plate text,
  driver_name text,
  driver_phone text,
  default_rep text,
  default_stop text,
  notes text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE fleet_vehicles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_fleet_vehicles" ON fleet_vehicles;
CREATE POLICY "anon_select_fleet_vehicles" ON fleet_vehicles FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_fleet_vehicles" ON fleet_vehicles;
CREATE POLICY "anon_insert_fleet_vehicles" ON fleet_vehicles FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_fleet_vehicles" ON fleet_vehicles;
CREATE POLICY "anon_update_fleet_vehicles" ON fleet_vehicles FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_fleet_vehicles" ON fleet_vehicles;
CREATE POLICY "anon_delete_fleet_vehicles" ON fleet_vehicles FOR DELETE
  TO anon, authenticated USING (true);

CREATE INDEX IF NOT EXISTS idx_fleet_vehicles_active ON fleet_vehicles(is_active);
CREATE INDEX IF NOT EXISTS idx_fleet_vehicles_type ON fleet_vehicles(type);

-- Auto-bump updated_at trigger
DROP TRIGGER IF EXISTS fleet_vehicles_updated_at ON fleet_vehicles;
CREATE TRIGGER fleet_vehicles_updated_at
  BEFORE UPDATE ON fleet_vehicles
  FOR EACH ROW
  EXECUTE FUNCTION bump_updated_at();

-- Seed standard initial fleet entries if empty
INSERT INTO fleet_vehicles (name, type, capacity, default_stop, is_active)
SELECT 'Quantum 1', 'Taxi', 15, 'Braamfontein', true
WHERE NOT EXISTS (SELECT 1 FROM fleet_vehicles WHERE name = 'Quantum 1');

INSERT INTO fleet_vehicles (name, type, capacity, default_stop, is_active)
SELECT 'Quantum 2', 'Taxi', 15, 'Braamfontein', true
WHERE NOT EXISTS (SELECT 1 FROM fleet_vehicles WHERE name = 'Quantum 2');

INSERT INTO fleet_vehicles (name, type, capacity, default_stop, is_active)
SELECT 'Main Bus 1', 'Bus', 60, 'Soweto', true
WHERE NOT EXISTS (SELECT 1 FROM fleet_vehicles WHERE name = 'Main Bus 1');
