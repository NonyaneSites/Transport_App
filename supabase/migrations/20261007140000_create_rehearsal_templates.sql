/*
# Create rehearsal_templates table

1. New Tables
- `rehearsal_templates`
  - `id` (text, primary key, default 'current')
  - `templates` (jsonb, default '[]'::jsonb) — array of taxi stop & timing template configurations
  - `created_at` (timestamptz, default now())
  - `updated_at` (timestamptz, default now())

2. Security
- Enable RLS on `rehearsal_templates`.
- Allow anon + authenticated CRUD for shared transport coordination.
*/

CREATE TABLE IF NOT EXISTS rehearsal_templates (
  id text PRIMARY KEY DEFAULT 'current',
  templates jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE rehearsal_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_rehearsal_templates" ON rehearsal_templates;
CREATE POLICY "anon_select_rehearsal_templates" ON rehearsal_templates FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_rehearsal_templates" ON rehearsal_templates;
CREATE POLICY "anon_insert_rehearsal_templates" ON rehearsal_templates FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_rehearsal_templates" ON rehearsal_templates;
CREATE POLICY "anon_update_rehearsal_templates" ON rehearsal_templates FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);
