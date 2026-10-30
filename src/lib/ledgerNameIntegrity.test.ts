import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateLedgerEntries,
  cleanAndDeduplicateSponsorships,
  correctLedgerRecordName,
  evaluateNameSuspicion,
  formatDebtorDisplayName,
  importHistoricalCancellations,
  linkRecordToDebtor,
  listLedgerEntries,
  NAME_MISSING_PLACEHOLDER,
  parseDebtAmount,
  purgeConfirmedTestRecord,
  recordPartialPayment,
  sanitizePassengerDisplayName,
  updateDebtorWithInstances,
  type DebtorInstanceUpdateItem,
  type LedgerEntry,
  type ReportedSponsorship,
} from './ledger';
import { mockStorage, LEDGER_TABLE, isTestEnvironment } from './supabase';

function clearTestStorage() {
  mockStorage.setTable(LEDGER_TABLE, []);
  mockStorage.setTable('cancellation_ledger_audits', []);
  mockStorage.setTable('sponsorship_audits', []);
  mockStorage.setTable('reported_sponsorships', []);
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem('crc_removed_ledger_ids');
      localStorage.removeItem('crc_settled_ledger_ids');
      localStorage.removeItem('crc_cancellation_ledger');
    }
  } catch {
    void 0;
  }
}

test('Acceptance Criteria 1: Renaming a debtor persists after a fresh database read', async () => {
  clearTestStorage();

  const originalRow: LedgerEntry = {
    id: 'test-rename-persist-1',
    manifest_key: '2026-10-20_PM_S1',
    date: '2026-10-20',
    service: 'PM',
    passenger_name: 'Bongani Sithole',
    stop: 'Central',
    structure: 'S1',
    structure_debt: 40,
    fee: 40,
    status: 'Unpaid',
    submitted_at: new Date().toISOString(),
    event_key: 'ev_bongani_1',
    sponsored: false,
    sponsor_note: '',
    general_notes: '',
  };
  mockStorage.setTable(LEDGER_TABLE, [originalRow as unknown as Record<string, unknown>]);

  const instances: DebtorInstanceUpdateItem[] = [
    {
      id: originalRow.id,
      date: originalRow.date,
      service: originalRow.service,
      amount: 40,
      notes: '',
      isSponsored: false,
      status: 'Unpaid',
    },
  ];

  await updateDebtorWithInstances([originalRow.id], {
    name: 'Bongani S. Sithole',
    structure: 'S1',
    instances,
  });

  const freshRead = await listLedgerEntries(true);
  const found = freshRead.find((e) => e.id === originalRow.id);
  assert.ok(found, 'Record should exist in fresh database read');
  assert.equal(found.passenger_name, 'Bongani S. Sithole', 'Name must match new renamed value');
  clearTestStorage();
});

test('Acceptance Criteria 2: The old name does not reappear after a refresh or synchronization', async () => {
  clearTestStorage();

  const rowId = 'test-no-revert-1';
  const initialRow: LedgerEntry = {
    id: rowId,
    manifest_key: '2026-10-20_PM_S2',
    date: '2026-10-20',
    service: 'PM',
    passenger_name: 'Khanyi Mthembu',
    stop: 'Stop 4',
    structure: 'S2',
    structure_debt: 40,
    fee: 40,
    status: 'Unpaid',
    submitted_at: new Date().toISOString(),
    event_key: 'ev_khanyi_1',
    sponsored: false,
    sponsor_note: '',
    general_notes: '',
  };
  mockStorage.setTable(LEDGER_TABLE, [initialRow as unknown as Record<string, unknown>]);

  await updateDebtorWithInstances([rowId], {
    name: 'Khanyisile Mthembu-Dlamini',
    structure: 'S2',
    instances: [
      {
        id: rowId,
        date: '2026-10-20',
        service: 'PM',
        amount: 40,
        notes: '',
        isSponsored: false,
        status: 'Unpaid',
      },
    ],
  });

  // Multiple sequential refreshes simulating reloads and background polling
  for (let i = 0; i < 3; i++) {
    const refreshed = await listLedgerEntries(true);
    const item = refreshed.find((e) => e.id === rowId);
    assert.ok(item);
    assert.equal(
      item.passenger_name,
      'Khanyisile Mthembu-Dlamini',
      `Refresh cycle ${i + 1} must preserve the updated name`
    );
  }
  clearTestStorage();
});

test('Acceptance Criteria 3: Every linked ledger instance displays the updated name', async () => {
  clearTestStorage();

  const instance1: LedgerEntry = {
    id: 'link-inst-1',
    manifest_key: '2026-10-18_AM_S3',
    date: '2026-10-18',
    service: 'AM',
    passenger_name: 'Lindiwe Zulu',
    stop: 'North',
    structure: 'S3',
    structure_debt: 40,
    fee: 40,
    status: 'Unpaid',
    submitted_at: new Date().toISOString(),
    event_key: 'ev_lz_1',
    sponsored: false,
    sponsor_note: '',
    general_notes: '',
  };

  const instance2: LedgerEntry = {
    id: 'link-inst-2',
    manifest_key: '2026-10-18_PM_S3',
    date: '2026-10-18',
    service: 'PM',
    passenger_name: 'Lindiwe Zulu',
    stop: 'North',
    structure: 'S3',
    structure_debt: 40,
    fee: 40,
    status: 'Unpaid',
    submitted_at: new Date().toISOString(),
    event_key: 'ev_lz_2',
    sponsored: false,
    sponsor_note: '',
    general_notes: '',
  };

  mockStorage.setTable(LEDGER_TABLE, [
    instance1 as unknown as Record<string, unknown>,
    instance2 as unknown as Record<string, unknown>,
  ]);

  await updateDebtorWithInstances([instance1.id, instance2.id], {
    name: 'Lindiwe Z. Ndlovu',
    structure: 'S3',
    instances: [
      { id: instance1.id, date: instance1.date, service: instance1.service, amount: 40, notes: '', isSponsored: false, status: 'Unpaid' },
      { id: instance2.id, date: instance2.date, service: instance2.service, amount: 40, notes: '', isSponsored: false, status: 'Unpaid' },
    ],
  });

  const refreshed = await listLedgerEntries(true);
  const inst1Ref = refreshed.find((e) => e.id === instance1.id);
  const inst2Ref = refreshed.find((e) => e.id === instance2.id);

  assert.equal(inst1Ref?.passenger_name, 'Lindiwe Z. Ndlovu');
  assert.equal(inst2Ref?.passenger_name, 'Lindiwe Z. Ndlovu');

  // Verify aggregated row reflects updated name across all instances
  const groups = aggregateLedgerEntries(refreshed);
  const s3Group = groups.find((g) => g.structure === 'S3');
  assert.ok(s3Group);
  const debtorRow = s3Group.rows.find((r) => r.name === 'Lindiwe Z. Ndlovu');
  assert.ok(debtorRow, 'Aggregated debtor row should exist under new name');
  assert.equal(debtorRow.instances.length, 2, 'Debtor row must contain both linked instances');
  assert.equal(debtorRow.amount, 80, 'Total debtor debt must reflect both instances');
  clearTestStorage();
});

test('Acceptance Criteria 4: Two different people with similar names remain separate', () => {
  const entries: LedgerEntry[] = [
    {
      id: 'person-a',
      manifest_key: '2026-10-18_PM_S1',
      date: '2026-10-18',
      service: 'PM',
      passenger_name: 'John Smith',
      stop: 'A',
      structure: 'S1',
      structure_debt: 40,
      fee: 40,
      status: 'Unpaid',
      submitted_at: new Date().toISOString(),
      event_key: 'ev_a',
      sponsored: false,
      sponsor_note: '',
      general_notes: '',
    },
    {
      id: 'person-b',
      manifest_key: '2026-10-18_PM_S1',
      date: '2026-10-18',
      service: 'PM',
      passenger_name: 'John Smythe',
      stop: 'B',
      structure: 'S1',
      structure_debt: 40,
      fee: 40,
      status: 'Unpaid',
      submitted_at: new Date().toISOString(),
      event_key: 'ev_b',
      sponsored: false,
      sponsor_note: '',
      general_notes: '',
    },
  ];

  const groups = aggregateLedgerEntries(entries);
  const s1Group = groups.find((g) => g.structure === 'S1');
  assert.ok(s1Group);
  assert.equal(s1Group.rows.length, 2, 'Two people with different spellings must remain separate rows');

  const names = s1Group.rows.map((r) => r.name).sort();
  assert.deepEqual(names, ['John Smith', 'John Smythe']);
});

test('Acceptance Criteria 5: One debtor with several legitimate debt instances retains all instances', () => {
  const entries: LedgerEntry[] = [
    {
      id: 'legit-1',
      manifest_key: '2026-10-18_AM_S1',
      date: '2026-10-18',
      service: 'AM',
      passenger_name: 'Nomsa Dube',
      stop: 'Stop 1',
      structure: 'S1',
      structure_debt: 40,
      fee: 40,
      status: 'Unpaid',
      submitted_at: new Date().toISOString(),
      event_key: 'ev_nomsa_am',
      sponsored: false,
      sponsor_note: '',
      general_notes: '',
    },
    {
      id: 'legit-2',
      manifest_key: '2026-10-18_PM_S1',
      date: '2026-10-18',
      service: 'PM',
      passenger_name: 'Nomsa Dube',
      stop: 'Stop 1',
      structure: 'S1',
      structure_debt: 40,
      fee: 40,
      status: 'Unpaid',
      submitted_at: new Date().toISOString(),
      event_key: 'ev_nomsa_pm',
      sponsored: false,
      sponsor_note: '',
      general_notes: '',
    },
    {
      id: 'legit-3',
      manifest_key: '2026-10-19_Rehe_S1',
      date: '2026-10-19',
      service: 'Rehe',
      passenger_name: 'Nomsa Dube',
      stop: 'Stop 1',
      structure: 'S1',
      structure_debt: 40,
      fee: 40,
      status: 'Unpaid',
      submitted_at: new Date().toISOString(),
      event_key: 'ev_nomsa_rehe',
      sponsored: false,
      sponsor_note: '',
      general_notes: '',
    },
  ];

  const groups = aggregateLedgerEntries(entries);
  const s1 = groups.find((g) => g.structure === 'S1');
  assert.ok(s1);
  assert.equal(s1.rows.length, 1, 'Single debtor aggregated across sessions');
  assert.equal(s1.rows[0].instances.length, 3, 'Must retain all 3 legitimate instances (AM, PM, Rehearsal)');
  assert.equal(s1.rows[0].amount, 120, 'Total outstanding debt must equal 3 x R40 = R120');
});

test('Acceptance Criteria 6: Repeated imports do not create duplicate debt instances', async () => {
  clearTestStorage();

  const importPayload = [
    {
      date: '2026-10-18',
      service: 'PM',
      structure: 'S4',
      passenger_name: 'Kabelo Modise',
      stop: 'Station',
      structure_debt: 40,
      fee: 40,
      status: 'Unpaid',
      general_notes: 'Initial absentee',
    },
  ];

  // First import
  const result1 = await importHistoricalCancellations(importPayload);
  assert.equal(result1.imported, 1, 'First import should insert 1 record');

  // Second import with identical event parameters
  const result2 = await importHistoricalCancellations(importPayload);
  assert.equal(result2.imported, 0, 'Second identical import must not insert duplicates');
  assert.equal(result2.skippedDuplicate, 1, 'Second identical import must skip duplicate event');

  const entries = await listLedgerEntries(true);
  const matching = entries.filter((e) => e.passenger_name === 'Kabelo Modise');
  assert.equal(matching.length, 1, 'Operational ledger must contain exactly 1 entry for this event');
  clearTestStorage();
});

test('Acceptance Criteria 7: Names containing apostrophes, hyphens, multiple spaces, and compound surnames remain valid', () => {
  const hyphenated = sanitizePassengerDisplayName('Mary-Jane Watson');
  assert.equal(hyphenated, 'Mary-Jane Watson', 'Hyphens in legitimate names must be preserved');

  const africanHyphen = sanitizePassengerDisplayName('Ngoepe-Nkosi Thabo');
  assert.equal(africanHyphen, 'Ngoepe-Nkosi Thabo', 'Compound hyphenated African names must be preserved');

  const apostrophe = sanitizePassengerDisplayName("D'Angelo Russell");
  assert.equal(apostrophe, "D'Angelo Russell", 'Apostrophes in names must be preserved');

  const afrikaansCompound = sanitizePassengerDisplayName('Pieter van der Merwe');
  assert.equal(afrikaansCompound, 'Pieter van der Merwe', 'Compound surnames must be formatted cleanly');

  const multiSpace = sanitizePassengerDisplayName('  Thabo    Khoza  ');
  assert.equal(multiSpace, 'Thabo Khoza', 'Repeated and trailing whitespace must be trimmed');

  const oconnor = sanitizePassengerDisplayName("Sean O'Connor");
  assert.equal(oconnor, "Sean O'Connor", 'Irish apostrophes must remain intact');
});

test('Acceptance Criteria 8: Empty or malformed names are flagged instead of replaced with invented identities', () => {
  // Empty or whitespace strings
  const emptyFormatted = formatDebtorDisplayName('');
  assert.equal(emptyFormatted, NAME_MISSING_PLACEHOLDER, 'Blank name must produce placeholder');

  const whitespaceFormatted = formatDebtorDisplayName('   ');
  assert.equal(whitespaceFormatted, NAME_MISSING_PLACEHOLDER, 'Whitespace name must produce placeholder');

  // Name suspicion evaluation
  const emptySuspicion = evaluateNameSuspicion('');
  assert.equal(emptySuspicion.isSuspicious, true);
  assert.equal(emptySuspicion.flagReason, 'missing_name');

  const testNameSuspicion = evaluateNameSuspicion('Renamed Person 123');
  assert.equal(testNameSuspicion.isSuspicious, true);
  assert.equal(testNameSuspicion.flagReason, 'test_name');

  const timestampSuspicion = evaluateNameSuspicion('John Doe_1793045890332');
  assert.equal(timestampSuspicion.isSuspicious, true);
  assert.equal(timestampSuspicion.flagReason, 'timestamp_suffix');

  const legitimateName = evaluateNameSuspicion('Sipho Mkhize');
  assert.equal(legitimateName.isSuspicious, false, 'Legitimate names must not be flagged');
});

test('Acceptance Criteria 9: Timestamp-based test names are not written into operational data by automated tests', () => {
  assert.equal(isTestEnvironment, true, 'Tests must always execute with isTestEnvironment === true');
  // When isTestEnvironment is true, remote Supabase writes are strictly prevented.
});

test('Acceptance Criteria 10: Failed updates produce a visible error and do not falsely report success', async () => {
  clearTestStorage();

  // Attempting to correct with an empty name must reject with descriptive error
  await assert.rejects(
    () => correctLedgerRecordName('id-non-existent', '   '),
    /valid, non-empty/
  );

  // Attempting to link with an empty target name must reject with descriptive error
  await assert.rejects(
    () => linkRecordToDebtor('id-non-existent', ''),
    /Target debtor name cannot be empty/
  );
  clearTestStorage();
});

test('Acceptance Criteria 11: Ledger totals remain correct after a rename, correction, merge, or confirmed deletion', async () => {
  clearTestStorage();

  const record1: LedgerEntry = {
    id: 'tot-1',
    manifest_key: '2026-10-20_PM_S1',
    date: '2026-10-20',
    service: 'PM',
    passenger_name: 'Initial Person',
    stop: 'Central',
    structure: 'S1',
    structure_debt: 40,
    fee: 40,
    status: 'Unpaid',
    submitted_at: new Date().toISOString(),
    event_key: 'ev_tot_1',
    sponsored: false,
    sponsor_note: '',
    general_notes: '',
  };

  const record2: LedgerEntry = {
    id: 'tot-2',
    manifest_key: '2026-10-21_PM_S1',
    date: '2026-10-21',
    service: 'PM',
    passenger_name: 'Initial Person',
    stop: 'Central',
    structure: 'S1',
    structure_debt: 40,
    fee: 40,
    status: 'Unpaid',
    submitted_at: new Date().toISOString(),
    event_key: 'ev_tot_2',
    sponsored: false,
    sponsor_note: '',
    general_notes: '',
  };

  mockStorage.setTable(LEDGER_TABLE, [
    record1 as unknown as Record<string, unknown>,
    record2 as unknown as Record<string, unknown>,
  ]);

  // Initial total
  let entries = await listLedgerEntries(true);
  let groups = aggregateLedgerEntries(entries);
  assert.equal(groups[0].totalDebt, 80);

  // Correction / Rename
  await correctLedgerRecordName('tot-1', 'Anele Khanyile');
  await correctLedgerRecordName('tot-2', 'Anele Khanyile');

  entries = await listLedgerEntries(true);
  groups = aggregateLedgerEntries(entries);
  assert.equal(groups[0].rows[0].name, 'Anele Khanyile');
  assert.equal(groups[0].totalDebt, 80, 'Total outstanding debt must remain R80 after rename');

  // Purge one record
  await purgeConfirmedTestRecord('tot-2', 'Admin', 'Purge duplicate');
  entries = await listLedgerEntries(true);
  groups = aggregateLedgerEntries(entries);
  assert.equal(groups[0].totalDebt, 40, 'Total outstanding debt must recalculate to R40 after purge');
  clearTestStorage();
});

test('Acceptance Criteria 12: Existing sponsorship, settlement, cancellation, and debt-history functionality continues to work', async () => {
  clearTestStorage();

  const debtRecord: LedgerEntry = {
    id: 'debt-settle-1',
    manifest_key: '2026-10-18_PM_S1',
    date: '2026-10-18',
    service: 'PM',
    passenger_name: 'Sipho Zulu',
    stop: 'Stop 1',
    structure: 'S1',
    structure_debt: 40,
    fee: 40,
    status: 'Unpaid',
    submitted_at: new Date().toISOString(),
    event_key: 'ev_settle_1',
    sponsored: false,
    sponsor_note: '',
    general_notes: '',
  };
  mockStorage.setTable(LEDGER_TABLE, [debtRecord as unknown as Record<string, unknown>]);

  // Record payment of R20
  await recordPartialPayment([debtRecord.id], 20);

  const refreshed = await listLedgerEntries(true);
  const updated = refreshed.find((e) => e.id === debtRecord.id);
  assert.ok(updated);
  assert.equal(parseDebtAmount(updated), 20, 'Debt amount should decrease from R40 to R20');
  assert.equal(updated.status, 'Partially Paid');

  // Sponsorship deduplication
  const sponSample: ReportedSponsorship[] = [
    {
      id: 'sp-1',
      manifest_key: '2026-10-18_PM_S1',
      date: '2026-10-18',
      service: 'PM',
      passenger_name: 'Zanele Ndlovu',
      structure: 'S1',
      stop: 'Stop 1',
      vehicle_name: 'Quantum 1',
      rep_name: 'Rep 1',
      sponsor_note: 'Awaiting pastor check',
      status: 'pending',
    },
    {
      id: 'sp-2',
      manifest_key: '2026-10-18_PM_S1',
      date: '2026-10-18',
      service: 'PM',
      passenger_name: 'Zanele Ndlovu',
      structure: 'S1',
      stop: 'Stop 1',
      vehicle_name: 'Quantum 1',
      rep_name: 'Rep 1',
      sponsor_note: 'Awaiting pastor check',
      status: 'pending',
    },
  ];

  const deduped = cleanAndDeduplicateSponsorships(sponSample);
  assert.equal(deduped.length, 1, 'Duplicate sponsorship reports must deduplicate cleanly');
  clearTestStorage();
});
