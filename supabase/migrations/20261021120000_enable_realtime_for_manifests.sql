-- ============================================================================
-- Migration: 20261021120000_enable_realtime_for_manifests.sql
-- Description: Idempotently enables Supabase Realtime for transport_manifests
--              to support live cross-device rep synchronization without polling lag.
-- ============================================================================

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
