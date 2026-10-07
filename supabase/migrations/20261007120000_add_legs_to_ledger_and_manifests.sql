/*
# Add legs column to cancellation_ledger

1. Alter Table
- `cancellation_ledger`
  - `legs` (text, default NULL) — 'both' | 'going' | 'return' for Rehearsal transport
*/

ALTER TABLE cancellation_ledger ADD COLUMN IF NOT EXISTS legs text DEFAULT NULL;
