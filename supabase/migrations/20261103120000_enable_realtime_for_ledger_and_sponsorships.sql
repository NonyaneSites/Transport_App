-- Enable Realtime publication for cancellation_ledger and sponsorship_audits tables
-- Ensures changes on any device trigger Realtime notifications across all devices
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND tablename = 'cancellation_ledger'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE cancellation_ledger;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND tablename = 'sponsorship_audits'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE sponsorship_audits;
    END IF;
  END IF;
END $$;
