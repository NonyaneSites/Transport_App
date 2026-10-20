# CRC Transport App V21 — Stage 1 targeted repair: financial security and rep submissions

Work on the currently uploaded V21 source code. This is ONLY Stage 1. Do not redesign UI, change finance balances, run destructive SQL, or attempt to remove Thursday Rehearsals in this task.

## Confirmed defects to resolve

1. `supabase/migrations/20261020110000_harden_financial_authorization_and_rpcs.sql` function `rep_submit_operational_debt` inserts and updates a column `vehicle`, whereas the provided cancellation ledger schema defines `vehicle_name`. Reconcile this with the actual deployed schema, use the canonical column consistently, and test a full submission. Do not guess column names.
2. The same function uses `ON CONFLICT (event_key)` but `20261019120000_fix_cancellation_ledger_persistence_and_audits.sql` creates only a non-unique `event_key` index. Add a safe uniqueness and historical deduplication plan. First report existing duplicate event keys; do not arbitrarily merge or delete financial records. Validate the PostgreSQL conflict target before deployment.
3. The public anonymous EXECUTE grant on `rep_submit_operational_debt` lets arbitrary unauthenticated callers insert a pending debt by supplying passenger details. Account-free reps must continue working, but a public endpoint cannot trust arbitrary identity, event keys, amounts, or session data. Design a scoped authorization mechanism tied to server-verified active manifest and rep assignment (or equivalent verifiable secret), rate limits, and validation. Ensure pending submissions require appropriate admin review and do not directly create collection-ready charges without validation. Confirm no easy replay or impersonation.
4. The migration's hardening of `cancellation_ledger` drops only named policies. Audit all effective pg_policies and grants, including legacy policies such as `anon_delete_ledger`, and close unwanted anonymous access, while preserving legitimate account-free operational workflows through limited RPCs. Do not restore broad anonymous table writes.
5. Inspect `sponsorship_audits` RLS. `src/pages/LedgerPage.tsx` contains setup SQL granting anonymous SELECT/INSERT/UPDATE/DELETE, and earlier migrations do likewise. Enforce that only approved Ledger Admins and Super Admins may approve/change financial classifications, with server-side enforcement and immutable audit history; rep reports should only be untrusted pending submissions, not privileged decisions.
6. Move any hardcoded Super Admin email bypass in `src/lib/types.ts` and authentication UI into a role obtained from approved Supabase profile claims. Keep the designated owner's secure bootstrap in an admin-controlled migration, but do not grant rights based only on a frontend email string. Verify direct-route and RPC denial for a logged-in rep and dispatch-only admin.
7. Remove the dangerous `_rollback.sql` file from automatically applied migration directories or ensure it cannot be auto-applied in the forward migration sequence. It explicitly recreates permissive anonymous financial access. Preserve it as a clearly non-executable manual recovery document if needed.

## Verification / acceptance criteria

- Start with schema inspection; produce reversible, idempotent migration(s), no production execution without approval.
- Run SQL tests in a staging Supabase instance for anon, rep, dispatch_admin, ledger_admin, and super_admin access (SELECT, INSERT, UPDATE, DELETE, RPC calls).
- Successfully submit one valid rep report without a rep account, reject invalid/fabricated and replayed submissions, and preserve settled/removed event tombstones.
- Test settle/remove RPC permissions and immutable audit trail; no repeat settlement or resurrection.
- Run `npm run typecheck`, `npm run build`, and tests if dependencies/environment permit. If unavailable, explicitly say so; do not claim success.
- At the end show files changed, full SQL migration order, tests actually run/results, blocked live-environment items. Stop after Stage 1.
