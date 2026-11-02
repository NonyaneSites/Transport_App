import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizePassengerDisplayName,
  aggregateLedgerEntries,
  isUUID,
  updateReportedSponsorship,
  type LedgerEntry,
  type ReportedSponsorship,
} from './ledger';
import { mockStorage, LEDGER_TABLE, SPONSORSHIPS_TABLE } from './supabase';

test('Multi-Device Sync 1: Slug passenger names are sanitized to Title Case without corrupting legitimate hyphenated names', () => {
  assert.equal(
    sanitizePassengerDisplayName('lufuno-pearl-moyo-campus-central--eoh'),
    'Lufuno Pearl Moyo'
  );
  assert.equal(
    sanitizePassengerDisplayName('john-doe-dfc-bus-stop'),
    'John Doe'
  );
  // Legitimate hyphenated names must be preserved intact
  assert.equal(sanitizePassengerDisplayName('Lisa-Marie Denga'), 'Lisa-Marie Denga');
  assert.equal(sanitizePassengerDisplayName('Athi-Enkosi Maningi'), 'Athi-Enkosi Maningi');
  assert.equal(sanitizePassengerDisplayName('Cran-Leigh Keyer'), 'Cran-Leigh Keyer');
});

test('Multi-Device Sync 2: Duplicate debt recognition merges repeated entries for same service occurrence into one logical debt', () => {
  const entries: LedgerEntry[] = [
    {
      id: '11111111-1111-4111-8111-111111111111',
      passenger_name: 'Kabelo Mokoena',
      structure: 'S1',
      date: '2026-10-25',
      service: 'AM',
      structure_debt: 40,
      fee: 40,
      status: 'Unpaid',
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      passenger_name: 'Kabelo Mokoena',
      structure: 'S1',
      date: '2026-10-25',
      service: 'AM',
      structure_debt: 40,
      fee: 40,
      status: 'Unpaid',
    },
    {
      id: '33333333-3333-4333-8333-333333333333',
      passenger_name: 'Kabelo Mokoena',
      structure: 'S1',
      date: '2026-10-25',
      service: 'AM',
      structure_debt: 40,
      fee: 40,
      status: 'Unpaid',
    },
    {
      id: '44444444-4444-4444-8444-444444444444',
      passenger_name: 'Kabelo Mokoena',
      structure: 'S1',
      date: '2026-10-25',
      service: 'AM',
      structure_debt: 40,
      fee: 40,
      status: 'Unpaid',
    },
  ];

  const groups = aggregateLedgerEntries(entries);
  assert.equal(groups.length, 1);
  const rows = groups[0].cancellationRows;
  assert.equal(rows.length, 1);

  const row = rows[0];
  // One logical debt occurrence: R40, NOT 4x R40 = R160
  assert.equal(row.amount, 40);
  assert.equal(row.instances.length, 1);
  assert.equal(row.instances[0].amount, 40);

  // All 4 duplicate row IDs must be tracked in entryIds so settling or removing cleans all rows
  assert.equal(row.entryIds.length, 4);
  assert.ok(row.entryIds.includes('11111111-1111-4111-8111-111111111111'));
  assert.ok(row.entryIds.includes('22222222-2222-4222-8222-222222222222'));
  assert.ok(row.entryIds.includes('33333333-3333-4333-8333-333333333333'));
  assert.ok(row.entryIds.includes('44444444-4444-4444-8444-444444444444'));
});

test('Multi-Device Sync 3: Legitimate distinct service occurrences are preserved', () => {
  const entries: LedgerEntry[] = [
    {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      passenger_name: 'Sipho Zulu',
      structure: 'S2',
      date: '2026-10-25',
      service: 'AM',
      structure_debt: 40,
      fee: 40,
      status: 'Unpaid',
    },
    {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      passenger_name: 'Sipho Zulu',
      structure: 'S2',
      date: '2026-10-25',
      service: 'PM', // Different service session
      structure_debt: 40,
      fee: 40,
      status: 'Unpaid',
    },
    {
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      passenger_name: 'Sipho Zulu',
      structure: 'S2',
      date: '2026-11-01', // Different date
      service: 'AM',
      structure_debt: 40,
      fee: 40,
      status: 'Unpaid',
    },
  ];

  const groups = aggregateLedgerEntries(entries);
  assert.equal(groups.length, 1);
  const rows = groups[0].cancellationRows;
  assert.equal(rows.length, 1);
  const row = rows[0];

  // Distinct occurrences are preserved: 3 sessions = R120
  assert.equal(row.amount, 120);
  assert.equal(row.instances.length, 3);
});

test('Multi-Device Sync 4: UUID validation strictly separates valid UUIDs from synthetic IDs', () => {
  assert.equal(isUUID('b974dbd9-a23a-400e-8d3b-d24e5d5a3fd2'), true);
  assert.equal(isUUID('c4003b47-1aef-48dd-ac54-bbd5b3bc32ec'), true);
  // Synthetic IDs must be strictly identified as non-UUID
  assert.equal(isUUID('ledger_sp_1791315588039_49p5t'), false);
  assert.equal(isUUID('v_spon_1730000000000'), false);
  assert.equal(isUUID('sp_2026-10-25_muanomulega'), false);
  assert.equal(isUUID(''), false);
  assert.equal(isUUID(null), false);
  assert.equal(isUUID(undefined), false);
});

test('Multi-Device Sync 5: Repeated sponsor edits update existing record and retain real UUID', async () => {
  mockStorage.setTable(SPONSORSHIPS_TABLE, []);
  mockStorage.setTable(LEDGER_TABLE, []);

  const sponId = 'sp_test_sync_1';
  const initialSpon: ReportedSponsorship = {
    id: sponId,
    passenger_name: 'Thabo Mbeki',
    structure: 'S3',
    date: '2026-10-18',
    service: 'AM',
    status: 'pending',
    rep_name: 'Rep Alex',
    vehicle_name: 'Bus 1',
    submitted_at: '2026-10-18T10:00:00Z',
    status_updated_at: '2026-10-18T10:00:00Z',
    ledger_entry_id: null,
  };
  mockStorage.setTable(SPONSORSHIPS_TABLE, [initialSpon as unknown as Record<string, unknown>]);

  // Edit 1: Mark as unaccounted sponsorship (adds debt)
  const res1 = await updateReportedSponsorship(sponId, {
    status: 'unaccounted_sponsorship',
    sponsor_note: 'Unaccounted note 1',
  });
  assert.equal(res1.success, true);
  const spon1 = res1.sponsorship;
  assert.ok(spon1?.ledger_entry_id);
  assert.ok(isUUID(spon1.ledger_entry_id));
  const assignedUuid = spon1.ledger_entry_id;

  // Verify only 1 ledger row was created
  const ledgerRows1 = (mockStorage.getTable(LEDGER_TABLE) as unknown as LedgerEntry[]) || [];
  assert.equal(ledgerRows1.length, 1);
  assert.equal(ledgerRows1[0].id, assignedUuid);

  // Edit 2: Subsequent edit modifying structure and note
  const res2 = await updateReportedSponsorship(sponId, {
    structure: 'S4',
    sponsor_note: 'Updated note 2',
  });
  assert.equal(res2.success, true);

  // Verify NO duplicate ledger row was created
  const ledgerRows2 = (mockStorage.getTable(LEDGER_TABLE) as unknown as LedgerEntry[]) || [];
  assert.equal(ledgerRows2.length, 1);
  assert.equal(ledgerRows2[0].id, assignedUuid);
  assert.equal(ledgerRows2[0].structure, 'S4');
});
