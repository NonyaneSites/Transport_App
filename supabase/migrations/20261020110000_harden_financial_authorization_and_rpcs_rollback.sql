-- ============================================================================
-- Migration Rollback: 20261020110000_harden_financial_authorization_and_rpcs_rollback.sql
-- Description: Reverts changes introduced by migration 20261020110000
-- WARNING: Only execute if explicitly approved by administrator.
-- ============================================================================

-- 1. Revert policies on cancellation_ledger
DROP POLICY IF EXISTS "ledger_select_policy" ON cancellation_ledger;
DROP POLICY IF EXISTS "ledger_insert_policy" ON cancellation_ledger;
DROP POLICY IF EXISTS "ledger_update_policy" ON cancellation_ledger;
DROP POLICY IF EXISTS "ledger_delete_policy" ON cancellation_ledger;

CREATE POLICY "anon_select_ledger" ON cancellation_ledger
  FOR SELECT TO anon, authenticated
  USING (true);

CREATE POLICY "anon_insert_ledger" ON cancellation_ledger
  FOR INSERT TO anon, authenticated
  WITH CHECK (true);

CREATE POLICY "anon_update_ledger" ON cancellation_ledger
  FOR UPDATE TO anon, authenticated
  USING (true)
  WITH CHECK (true);

-- 2. Revert policies on cancellation_ledger_audits
DROP POLICY IF EXISTS "audits_select_policy" ON cancellation_ledger_audits;
DROP POLICY IF EXISTS "audits_insert_policy" ON cancellation_ledger_audits;

CREATE POLICY "audits_select_policy" ON cancellation_ledger_audits
  FOR SELECT TO anon, authenticated
  USING (true);

CREATE POLICY "audits_insert_policy" ON cancellation_ledger_audits
  FOR INSERT TO anon, authenticated
  WITH CHECK (true);

-- 3. Revert settle_cancellation_debts & remove_cancellation_debts to previous implementation if needed
GRANT EXECUTE ON FUNCTION settle_cancellation_debts(text[], text, text) TO PUBLIC, anon;
GRANT EXECUTE ON FUNCTION remove_cancellation_debts(text[], text, text) TO PUBLIC, anon;

-- 4. Drop scoped rep RPC
DROP FUNCTION IF EXISTS rep_submit_operational_debt(text, text, text, text, text, text, text, text, text);

-- 5. Drop role helper functions
DROP FUNCTION IF EXISTS public.is_dispatch_admin_or_super();
DROP FUNCTION IF EXISTS public.is_ledger_admin_or_super();
DROP FUNCTION IF EXISTS public.is_super_admin_user();
