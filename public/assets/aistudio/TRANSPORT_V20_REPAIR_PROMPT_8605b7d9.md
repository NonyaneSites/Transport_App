# CRC Transport App V20 — Targeted Security and Functionality Fixes

Use the uploaded **Transport_App-main (20).zip** as the source of truth. Apply these changes to the actual code and SQL migrations. Do not simply describe them. Preserve real passenger, payment, and historical audit data. First show a change plan and migration rollback plan, then implement and test in staging. Do not run anything against live Supabase without explicit administrator approval.

## P0 — Fix financial authorization and unsafe RPCs

1. In `supabase/migrations/20261019120000_fix_cancellation_ledger_persistence_and_audits.sql`, remove anonymous permissive `SELECT/INSERT/UPDATE` access to the full `cancellation_ledger` and `cancellation_ledger_audits` tables. Restrict personally identifiable and financial data to appropriate admins. Allow account-free transport reps to submit only scoped operational reports via narrowly scoped server-side RPC or an authenticated server endpoint; do not give public clients direct ledger read/write privileges.
2. `settle_cancellation_debts` and `remove_cancellation_debts` use `SECURITY DEFINER` but currently lack internal identity/role verification. Add strict `auth.uid()` checks against approved profile roles, explicit grants/revokes, fixed safe search path, input validation, and transactional audit records with trustworthy actor identity derived from auth, not caller-submitted names. Check all other privileged RPCs for the same flaw. Prevent anonymous and arbitrary authenticated users from calling them.
3. Avoid open audit-log insertion, tampering, or reading by unauthenticated users. Ensure previously settled/removed debt cannot be silently reinserted through old imports or local caches. Validate effective final RLS policy state after applying all migrations in timestamp order, not just isolated SQL files.
4. Test direct Supabase requests, not just frontend route guards: anon, unauthorised signed-in, rep, dispatch_admin, ledger_admin, super_admin. Verify all unauthorised settlements, removals, sponsorship approvals, and audit writes fail.

## P0 — Correct role isolation without losing owner access

1. In `src/lib/types.ts`, `canRoleAccessLedger` currently includes `dispatch_admin` and `dispatcher`; remove these unless explicitly designated as dual-role accounts. Dispatch admins must not automatically have Ledger permissions. Introduce explicit dual-role capabilities only when configured deliberately.
2. `SUPER_ADMIN_EMAILS` is currently in frontend source. Email matching may be used only as display convenience, never as the authoritative grant. Server-side profile/claims and RLS must determine true super-admin rights. Securely provision the owner account `nonyaneamo@gmail.com` as `super_admin` through an administrator-controlled migration, with no public role escalation.
3. Keep three distinct accounts/capabilities: super_admin (all), dispatch_admin (dispatch), ledger_admin (ledger/sponsorships). Reps remain account-free using the existing uploaded rep list, with strictly limited rights to their operational submissions.
4. Test direct navigation, reload, deep links and Supabase operations for all roles.

## P1 — Completely retire Thursday Rehearsals

1. `src/pages/AdminPage.tsx` still lazy-loads `ThursdayRehearsalUpload`, and `src/pages/RepPage.tsx` contains active rehearsal-only fare, attendance, transfer, and walk-in paths. `src/lib/types.ts` still includes `'Rehearsal'` as a service. Eliminate all current-facing Thursday/Rehearsal options, uploads, scheduling, fare logic, rep controls, exports, and recurrence rules. Remove dead modules and references only after checking service compatibility and passing TypeScript/lint tests.
2. Preserve archival `Rehearsal` manifest, ledger, payment, and audit data read-only; do not delete history or silently reinterpret historical fares. Old cached data must not reactivate the feature. Sunday and DreamWeek workflows must continue working unchanged.
3. Check admin, rep, reports, PDFs, schemas, validation, test fixtures, and imports for retired feature paths.

## P1 — Sponsorship reconciliation and confirmation

1. Deduplicate reports by durable event IDs (passenger/person identity when known, service/date/session, vehicle when appropriate, sponsorship category); never deduplicate based solely on name. Migrate historical duplicates with review, not blind deletion.
2. Pending, Actually Sponsored, Unaccounted, Unpaid, Settled, Removed must be distinct persisted statuses with explicit transitions. A resolved report must not appear as new pending after reload, offline replay, repeated import or device switch.
3. Batch processing must stage changes and display the exact impact before a Ledger Admin/Super Admin confirms. No database mutations before confirmation. Use atomic updates and audits; only show success after awaited server confirmation. Provide retryable errors and lightweight filtering/pagination for speed.
4. Account-free reps can submit a report but cannot confirm, settle, remove, or directly edit an existing financial record.

## P1 — Cancellation debt baseline and temporal correctness

1. Use the user-supplied 12 October 2026 corrected PDF as historical benchmark: 938 listed debtors and R51,425 reported outstanding, not the 6 October report. Do NOT force live totals to match this baseline; legitimate changes after 12 October must be retained.
2. Build row-level reconciliation with date/service, debt type, amount, status, import source, and auditable actions. The historical PDF includes separate ordinary debt and unaccounted-sponsorship/unpaid categories; preserve that distinction. Flag ambiguous name/spelling matches for manual review.
3. Do not resurrect settled/removed historical debt. Allow only the Ledger Admin/Super Admin to approve the proposed diff; back up existing data and provide rollback scripts.

## Verification and deliverables

- Install dependencies and run `npm run typecheck`, `npm run build`, `npm run lint`, and `npm test`; report failures honestly. Add focused RLS/RPC security tests, permission matrix tests, idempotency/offline replay tests, and Thursday removal regression tests.
- Provide changed file list, exact SQL migration scripts (safe forward migration, never rewrite applied migrations blindly), migration order, a rollback procedure, staging test evidence, and any unresolved constraints.
- Never hardcode secrets, expose service-role keys in Vite bundles, fake confirmation success, or run destructive production resets.
