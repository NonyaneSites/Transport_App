import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateLedgerEventKey,
  sanitizeCancellationLedgerPayload,
  CANONICAL_LEDGER_COLUMNS,
  aggregateLedgerEntries,
  cleanAndDeduplicateSponsorships,
  updateDebtorWithInstances,
  listLedgerEntries,
  type LedgerEntry,
  type ReportedSponsorship,
} from './ledger';
import { mockStorage, LEDGER_TABLE } from './supabase';

test('Cancellation Ledger: Event key generation is deterministic and unique per event', () => {
  const key1 = generateLedgerEventKey({
    passengerName: '  John Doe  ',
    date: '2026-10-18',
    service: 'PM Service',
    structure: 'S1',
  });

  const key2 = generateLedgerEventKey({
    passengerName: 'John Doe',
    date: '2026-10-18',
    service: 'pm',
    structure: 's1',
  });

  assert.strictEqual(key1, key2);

  // Different date must produce different key
  const key3 = generateLedgerEventKey({
    passengerName: 'John Doe',
    date: '2026-10-19',
    service: 'PM Service',
    structure: 'S1',
  });
  assert.notStrictEqual(key1, key3);

  // Different service must produce different key
  const key4 = generateLedgerEventKey({
    passengerName: 'John Doe',
    date: '2026-10-18',
    service: 'AM Service',
    structure: 'S1',
  });
  assert.notStrictEqual(key1, key4);
});

test('Cancellation Ledger: Payload sanitizer strictly permits ONLY canonical 23 schema columns', () => {
  const rawPayload = {
    id: '123e4567-e89b-12d3-a456-426614174000',
    passenger_name: 'Jane Smith',
    structure: 'S2',
    date: '2026-10-18',
    service_type: 'Sunday',
    fee: 40,
    status: 'Settled',
    notes: 'Paid cash',
    sponsored_by: '',
    submitted_at: '2026-10-18T12:00:00Z',
    created_at: '2026-10-18T12:00:00Z',
    manifest_key: '2026-10-18_PM_Bus_1',
    vehicle_name: 'Bus 1',
    vehicle_id: 'v1',
    rep_name: 'Sarah',
    service: 'PM',
    stop: 'Campus Gate',
    submitted_by: 'Sarah',
    license_plate: 'CA 123-456',
    sponsored: false,
    sponsor_note: '',
    structure_debt: 0,
    general_notes: 'Paid cash',
    // Arbitrary fields that do NOT exist in the 23-column public.cancellation_ledger table:
    source: 'some_external_source',
    non_existent_column: 'malformed_value',
    custom_temp_field: 999,
  };

  const sanitized = sanitizeCancellationLedgerPayload(rawPayload);

  // Must not have non-existent columns
  assert.strictEqual('source' in sanitized, false);
  assert.strictEqual('non_existent_column' in sanitized, false);
  assert.strictEqual('custom_temp_field' in sanitized, false);

  // Must retain canonical columns
  assert.strictEqual(sanitized.passenger_name, 'Jane Smith');
  assert.strictEqual(sanitized.status, 'Settled');
  assert.strictEqual(sanitized.structure_debt, 0);
  assert.strictEqual(sanitized.fee, 40);

  // Verify all keys in sanitized are within canonical schema
  for (const key of Object.keys(sanitized)) {
    assert.ok(
      (CANONICAL_LEDGER_COLUMNS as readonly string[]).includes(key),
      `Column ${key} is not in canonical cancellation_ledger schema`
    );
  }
});

test('Cancellation Ledger: Settled and Removed records are excluded from active debt calculations', () => {
  const entries: LedgerEntry[] = [
    {
      id: 'active-1',
      manifest_key: '2026-10-04_PM',
      date: '2026-10-04',
      service: 'PM',
      passenger_name: 'Active Debtor',
      stop: 'Stop A',
      structure: 'S1',
      vehicle_name: 'Taxi 1',
      submitted_by: 'Rep',
      submitted_at: '2026-10-04T12:00:00Z',
      sponsored: false,
      sponsor_note: '',
      license_plate: '',
      rep_name: 'Rep',
      structure_debt: 40,
      fee: 40,
      status: 'Unpaid',
      general_notes: '',
    },
    {
      id: 'settled-1',
      manifest_key: '2026-10-04_PM',
      date: '2026-10-04',
      service: 'PM',
      passenger_name: 'Settled Person',
      stop: 'Stop B',
      structure: 'S1',
      vehicle_name: 'Taxi 1',
      submitted_by: 'Rep',
      submitted_at: '2026-10-04T12:00:00Z',
      sponsored: false,
      sponsor_note: '',
      license_plate: '',
      rep_name: 'Rep',
      structure_debt: 0,
      fee: 40,
      status: 'Settled',
      general_notes: 'Paid in full',
    },
    {
      id: 'removed-1',
      manifest_key: '2026-10-04_PM',
      date: '2026-10-04',
      service: 'PM',
      passenger_name: 'Removed Person',
      stop: 'Stop C',
      structure: 'S1',
      vehicle_name: 'Taxi 1',
      submitted_by: 'Rep',
      submitted_at: '2026-10-04T12:00:00Z',
      sponsored: false,
      sponsor_note: '',
      license_plate: '',
      rep_name: 'Rep',
      structure_debt: 0,
      fee: 40,
      status: 'Removed',
      general_notes: 'Removed by admin',
    },
  ];

  const aggregatedGroups = aggregateLedgerEntries(entries);
  const allRows = aggregatedGroups.flatMap((g) => g.rows);

  // Only the active debtor should appear in aggregated active debts
  assert.strictEqual(allRows.length, 1);
  assert.strictEqual(allRows[0].name, 'Active Debtor');
  assert.strictEqual(allRows[0].amount, 40);

  // Historical fee must remain intact even when structure_debt is 0
  assert.strictEqual(entries[1].fee, 40);
  assert.strictEqual(entries[1].structure_debt, 0);
  assert.strictEqual(entries[1].status, 'Settled');

  assert.strictEqual(entries[2].fee, 40);
  assert.strictEqual(entries[2].structure_debt, 0);
  assert.strictEqual(entries[2].status, 'Removed');
});

test('Sponsorship Deduplication: Actually sponsored and settled states are preserved', () => {
  const sponsorships: ReportedSponsorship[] = [
    {
      id: 'spon-1',
      manifest_key: '2026-10-11_PM',
      date: '2026-10-11',
      service: 'PM',
      passenger_name: 'Michael Tau',
      structure: 'S2',
      vehicle_name: 'Taxi 1',
      rep_name: 'Rep',
      sponsor_note: 'Verified payment',
      status: 'actually_sponsored',
      submitted_at: '2026-10-11T12:00:00Z',
      status_updated_at: '2026-10-12T09:00:00Z',
    },
    {
      id: 'spon-1-reimport',
      manifest_key: '2026-10-11_PM',
      date: '2026-10-11',
      service: 'PM',
      passenger_name: 'Michael Tau',
      structure: 'S2',
      vehicle_name: 'Taxi 1',
      rep_name: 'Rep',
      sponsor_note: '',
      status: 'pending',
      submitted_at: '2026-10-11T12:00:00Z',
    },
  ];

  const deduplicated = cleanAndDeduplicateSponsorships(sponsorships);
  assert.strictEqual(deduplicated.length, 1);
  // Verified status must be preserved and not degraded back to 'pending'
  assert.strictEqual(deduplicated[0].status, 'actually_sponsored');
});

test('Debtor Edit Persistence: updateDebtorWithInstances persists name, structure, instances, and debt without reverting', async () => {
  const initialName = 'Thando Khumalo';
  const targetName = 'Thando K. Khumalo';
  const initialId = 'mock-persist-id-1';

  const initialRow: LedgerEntry = {
    id: initialId,
    manifest_key: '2026-10-18_PM',
    date: '2026-10-18',
    service: 'PM',
    passenger_name: initialName,
    stop: 'Gate 1',
    structure: 'S1',
    vehicle_name: 'Taxi 1',
    submitted_by: 'Cancellation Admin',
    submitted_at: '2026-10-18T12:00:00Z',
    sponsored: false,
    sponsor_note: '',
    license_plate: '',
    rep_name: 'Rep',
    structure_debt: 40,
    general_notes: 'Initial cancellation',
    status: 'Unpaid',
  };

  mockStorage.setTable(LEDGER_TABLE, [initialRow as unknown as Record<string, unknown>]);

  // Perform debtor update: change name to targetName, structure to "S15", and add an extra date instance
  await updateDebtorWithInstances([initialRow.id], {
    name: targetName,
    structure: 'S15',
    isSponsored: false,
    debtType: 'cancellation',
    notes: 'Updated note',
    instances: [
      { id: initialRow.id, date: '2026-10-18', service: 'PM', amount: 35 },
      { date: '2026-10-25', service: 'AM', amount: 45 },
    ],
  });

  // Re-fetch via listLedgerEntries (simulating refresh / fresh read)
  const refreshed = await listLedgerEntries(true);
  const updatedRows = refreshed.filter((e) => e.passenger_name === targetName);

  assert.strictEqual(updatedRows.length, 2, 'Must have exactly 2 instances for updated debtor');
  assert.strictEqual(updatedRows[0].structure, 'S15');
  assert.strictEqual(updatedRows[0].passenger_name, targetName);

  // Must not have any entries under original name
  const oldRows = refreshed.filter((e) => e.passenger_name === initialName);
  assert.strictEqual(oldRows.length, 0, 'Original name must not exist after rename');

  // Verify aggregated row computes correct new debt
  const aggregated = aggregateLedgerEntries(refreshed);
  const debtorGroup = aggregated.find((g) => g.structure === 'S15');
  assert.ok(debtorGroup, 'Group for S15 must exist');
  const debtorRow = debtorGroup.rows.find((r) => r.name === targetName);
  assert.ok(debtorRow, 'Row for target debtor must exist');
  assert.strictEqual(debtorRow.amount, 80, 'Total debt must equal 35 + 45 = 80');

  // Clean up mock rows
  mockStorage.setTable(LEDGER_TABLE, []);
});

test('Cross-Device Sync: Newer status_updated_at strictly takes precedence over older non-pending status', async () => {
  // Device B has an older local cache where sponsorship was marked "unaccounted_sponsorship" at 10:00
  const olderSpon: ReportedSponsorship = {
    id: 'sp_2026-10-25_johndoe',
    manifest_key: '2026-10-25_pm',
    date: '2026-10-25',
    service: 'PM',
    passenger_name: 'John Doe',
    structure: 'S10',
    stop: 'Main Stop',
    vehicle_name: 'Taxi 1',
    rep_name: 'Rep 1',
    sponsor_note: 'Unaccounted note',
    status: 'unaccounted_sponsorship',
    status_updated_at: '2026-10-25T10:00:00.000Z',
    submitted_at: '2026-10-25T08:00:00.000Z',
  };

  // Device A settled this sponsorship or marked it "actually_sponsored" at 10:30
  const newerSpon: ReportedSponsorship = {
    id: 'sp_2026-10-25_johndoe',
    manifest_key: '2026-10-25_pm',
    date: '2026-10-25',
    service: 'PM',
    passenger_name: 'John Doe',
    structure: 'S10',
    stop: 'Main Stop',
    vehicle_name: 'Taxi 1',
    rep_name: 'Rep 1',
    sponsor_note: 'Settled by Pastor',
    status: 'actually_sponsored',
    status_updated_at: '2026-10-25T10:30:00.000Z',
    submitted_at: '2026-10-25T08:00:00.000Z',
  };

  // When Device B receives the newer change from server/Supabase and merges:
  const mergedOrder1 = cleanAndDeduplicateSponsorships([olderSpon, newerSpon]);
  assert.strictEqual(mergedOrder1.length, 1);
  assert.strictEqual(mergedOrder1[0].status, 'actually_sponsored', 'Newer actually_sponsored must win over older unaccounted');
  assert.strictEqual(mergedOrder1[0].sponsor_note, 'Settled by Pastor');

  // Reverse input order must also produce the exact same authoritative result
  const mergedOrder2 = cleanAndDeduplicateSponsorships([newerSpon, olderSpon]);
  assert.strictEqual(mergedOrder2.length, 1);
  assert.strictEqual(mergedOrder2[0].status, 'actually_sponsored', 'Order of arrival must not matter');
});

test('Cross-Device Sync: Editing structure and name updates status_updated_at and syncs cleanly', async () => {
  const originalSpon: ReportedSponsorship = {
    id: 'sp_2026-10-25_sarahconnor',
    manifest_key: '2026-10-25_pm',
    date: '2026-10-25',
    service: 'PM',
    passenger_name: 'Sarah Connor',
    structure: 'S01',
    stop: 'Stop 1',
    vehicle_name: 'Taxi 2',
    rep_name: 'Rep 2',
    sponsor_note: 'Did not pay',
    status: 'unpaid_sponsorship',
    status_updated_at: '2026-10-25T09:00:00.000Z',
    submitted_at: '2026-10-25T08:00:00.000Z',
  };

  // Device A reclassifies structure to S05 and corrects name spelling at 09:15
  const updatedSpon: ReportedSponsorship = {
    ...originalSpon,
    passenger_name: 'Sarah O. Connor',
    structure: 'S05',
    status_updated_at: '2026-10-25T09:15:00.000Z',
  };

  const deduplicated = cleanAndDeduplicateSponsorships([originalSpon, updatedSpon]);
  assert.strictEqual(deduplicated.length, 1);
  assert.strictEqual(deduplicated[0].structure, 'S05');
  assert.strictEqual(deduplicated[0].passenger_name, 'Sarah O. Connor');
  assert.strictEqual(deduplicated[0].status, 'unpaid_sponsorship');
});

