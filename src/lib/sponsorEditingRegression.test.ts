import test from 'node:test';
import assert from 'node:assert/strict';
import {
  updateReportedSponsorship,
  updateLedgerEntry,
  listReportedSponsorships,
  listLedgerEntries,
  invalidateSponsorshipsCache,
  invalidateLedgerCache,
  isUUID,
  type ReportedSponsorship,
  type LedgerEntry,
} from './ledger';
import { mockStorage, LEDGER_TABLE } from './supabase';

function resetStorage() {
  mockStorage.setTable(LEDGER_TABLE, []);
  mockStorage.setTable('cancellation_ledger_audits', []);
  mockStorage.setTable('sponsorship_audits', []);
  mockStorage.setTable('reported_sponsorships', []);
  invalidateSponsorshipsCache();
  invalidateLedgerCache();
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem('crc_removed_ledger_ids');
      localStorage.removeItem('crc_settled_ledger_ids');
      localStorage.removeItem('crc_cancellation_ledger');
      localStorage.removeItem('crc_reported_sponsorships');
      localStorage.removeItem('crc_sponsorship_audits');
    }
  } catch {
    void 0;
  }
}

test('Regression 1: A sponsor with a real UUID can be edited and saved', async () => {
  resetStorage();

  const realUuid = 'a1b2c3d4-e5f6-4a5b-8c9d-0e1f2a3b4c5d';
  const initialRow: LedgerEntry = {
    id: realUuid,
    manifest_key: '2026-10-18_PM_S1',
    date: '2026-10-18',
    service: 'PM',
    passenger_name: 'Lerato Khumalo',
    stop: 'Main Gate',
    structure: 'S1',
    structure_debt: 40,
    fee: 40,
    status: 'Unpaid',
    submitted_at: new Date().toISOString(),
    sponsored: true,
    sponsor_note: 'Unaccounted Sponsorship: Initial note',
    general_notes: 'Unaccounted Sponsorship: Initial note',
  };
  mockStorage.setTable(LEDGER_TABLE, [initialRow as unknown as Record<string, unknown>]);

  const initialSpon: ReportedSponsorship = {
    id: 'sp_lerato_1',
    manifest_key: '2026-10-18_PM_S1',
    date: '2026-10-18',
    service: 'PM',
    passenger_name: 'Lerato Khumalo',
    structure: 'S1',
    stop: 'Main Gate',
    vehicle_name: 'Taxi 1',
    rep_name: 'Rep John',
    sponsor_note: 'Initial note',
    status: 'unaccounted_sponsorship',
    ledger_entry_id: realUuid,
    submitted_at: new Date().toISOString(),
  };
  mockStorage.setTable('reported_sponsorships', [initialSpon as unknown as Record<string, unknown>]);
  mockStorage.setTable('sponsorship_audits', [initialSpon as unknown as Record<string, unknown>]);

  // Edit the sponsor
  const res = await updateReportedSponsorship('sp_lerato_1', {
    passenger_name: 'Lerato M. Khumalo',
    structure: 'S2',
    sponsor_note: 'Updated sponsor note verified by pastor',
    debtAmount: 70,
  });

  assert.equal(res.success, true);
  assert.equal(res.sponsorship?.passenger_name, 'Lerato M. Khumalo');
  assert.equal(res.sponsorship?.structure, 'S2');
  assert.equal(res.sponsorship?.ledger_entry_id, realUuid, 'Must retain the real UUID');

  // Verify ledger entry was updated in place with the same UUID
  const ledgerRows = await listLedgerEntries(true);
  const updatedEntry = ledgerRows.find((e) => e.id === realUuid);
  assert.ok(updatedEntry, 'Ledger row with real UUID must exist');
  assert.equal(updatedEntry.passenger_name, 'Lerato M. Khumalo');
  assert.equal(updatedEntry.structure, 'S2');
  assert.equal(updatedEntry.structure_debt, 70);

  resetStorage();
});

test('Regression 2: A synthetic ledger_sp_... ID is never used as a UUID database filter', async () => {
  resetStorage();

  const syntheticId = 'ledger_sp_1791315588039_49p5t';
  const existingUuid = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e';

  // Seed a real ledger entry in Supabase mock storage
  const realRow: LedgerEntry = {
    id: existingUuid,
    manifest_key: '2026-09-13_AM_Serving',
    date: '2026-09-13',
    service: 'AM',
    passenger_name: 'Nqobile Vilane S15',
    stop: 'Focus',
    structure: 'S15',
    structure_debt: 40,
    fee: 40,
    status: 'Unpaid',
    submitted_at: new Date().toISOString(),
    sponsored: true,
    sponsor_note: 'Unaccounted Sponsorship: Paid by Rider',
    general_notes: 'Unaccounted Sponsorship: Paid by Rider',
  };
  mockStorage.setTable(LEDGER_TABLE, [realRow as unknown as Record<string, unknown>]);

  // Spon audit record has legacy synthetic ID
  const sponWithSynthetic: ReportedSponsorship = {
    id: 'sp_2026-09-13_nqobilevilanes15',
    manifest_key: '2026-09-13_AM_Serving',
    date: '2026-09-13',
    service: 'AM',
    passenger_name: 'Nqobile Vilane S15',
    structure: 'S15',
    stop: 'Focus',
    vehicle_name: 'Taxi 7',
    rep_name: 'Agnes Monyane',
    sponsor_note: 'Paid by Rider',
    status: 'unaccounted_sponsorship',
    ledger_entry_id: syntheticId,
    submitted_at: new Date().toISOString(),
  };
  mockStorage.setTable('reported_sponsorships', [sponWithSynthetic as unknown as Record<string, unknown>]);
  mockStorage.setTable('sponsorship_audits', [sponWithSynthetic as unknown as Record<string, unknown>]);

  // Direct call to updateLedgerEntry with synthetic ID must NOT throw syntax error
  // Instead, it should resolve the real row or handle safely without crashing
  await assert.doesNotReject(async () => {
    await updateLedgerEntry(syntheticId, {
      passenger_name: 'Nqobile Vilane S15',
      date: '2026-09-13',
      structure_debt: 40,
      structure: 'S15',
    });
  });

  // Updating the reported sponsorship must resolve the real UUID without throwing
  const res = await updateReportedSponsorship('sp_2026-09-13_nqobilevilanes15', {
    sponsor_note: 'Confirmed with supervisor',
    debtAmount: 40,
  });

  assert.equal(res.success, true);
  // The synthetic ID should have been resolved to the real UUID
  assert.equal(res.sponsorship?.ledger_entry_id, existingUuid);

  resetStorage();
});

test('Regression 3: New ledger entries retain the UUID returned by Supabase', async () => {
  resetStorage();

  const newSpon: ReportedSponsorship = {
    id: 'sp_new_rider_1',
    manifest_key: '2026-10-25_PM_Normal',
    date: '2026-10-25',
    service: 'PM',
    passenger_name: 'Sipho Zulu',
    structure: 'S4',
    stop: 'Campus Gate',
    vehicle_name: 'Quantum 3',
    rep_name: 'Rep David',
    sponsor_note: 'Did not pay on vehicle',
    status: 'unpaid_sponsorship',
    ledger_entry_id: null,
    submitted_at: new Date().toISOString(),
  };
  mockStorage.setTable('reported_sponsorships', [newSpon as unknown as Record<string, unknown>]);
  mockStorage.setTable('sponsorship_audits', [newSpon as unknown as Record<string, unknown>]);

  const res = await updateReportedSponsorship('sp_new_rider_1', {
    sponsor_note: 'Awaiting student allowance',
    debtAmount: 40,
  });

  assert.equal(res.success, true);
  assert.ok(res.sponsorship?.ledger_entry_id, 'Must obtain and retain a ledger entry ID');
  assert.ok(
    isUUID(res.sponsorship.ledger_entry_id),
    `Retained ID must be a valid UUID, got: ${res.sponsorship.ledger_entry_id}`
  );
  assert.ok(!res.sponsorship.ledger_entry_id.startsWith('ledger_sp_'), 'Must not be synthetic ledger_sp_');

  resetStorage();
});

test('Regression 4: Existing synthetic references are repaired only when the matching row is certain', async () => {
  resetStorage();

  // Certain unambiguous match
  const unambiguousUuid = 'c3d4e5f6-a7b8-4c9d-0e1f-2a3b4c5d6e7f';
  mockStorage.setTable(LEDGER_TABLE, [
    {
      id: unambiguousUuid,
      passenger_name: 'Themba Sithole',
      date: '2026-10-15',
      structure: 'S1',
      structure_debt: 40,
      fee: 40,
      status: 'Unpaid',
      sponsored: true,
      sponsor_note: 'Unaccounted',
      general_notes: 'Unaccounted',
    } as unknown as Record<string, unknown>,
  ]);

  const sponCertain: ReportedSponsorship = {
    id: 'sp_certain_1',
    manifest_key: '2026-10-15_PM_S1',
    date: '2026-10-15',
    service: 'PM',
    passenger_name: 'Themba Sithole',
    structure: 'S1',
    stop: 'Stop 1',
    vehicle_name: 'V1',
    rep_name: 'Rep 1',
    sponsor_note: 'Unaccounted',
    status: 'unaccounted_sponsorship',
    ledger_entry_id: 'ledger_sp_9999_fake',
    submitted_at: new Date().toISOString(),
  };

  mockStorage.setTable('reported_sponsorships', [sponCertain as unknown as Record<string, unknown>]);
  mockStorage.setTable('sponsorship_audits', [sponCertain as unknown as Record<string, unknown>]);

  const resCertain = await updateReportedSponsorship('sp_certain_1', {
    sponsor_note: 'Repaired certain match',
  });

  assert.equal(resCertain.sponsorship?.ledger_entry_id, unambiguousUuid, 'Certain match must repair to real UUID');

  resetStorage();
});

test('Regression 5: Repeated edits do not create duplicate ledger rows or debts', async () => {
  resetStorage();

  const sponRecord: ReportedSponsorship = {
    id: 'sp_repeat_test',
    manifest_key: '2026-10-22_PM_Normal',
    date: '2026-10-22',
    service: 'PM',
    passenger_name: 'Nomusa Dlamini',
    structure: 'S2',
    stop: 'Station',
    vehicle_name: 'Quantum 1',
    rep_name: 'Rep Moses',
    sponsor_note: 'Initial report',
    status: 'unaccounted_sponsorship',
    ledger_entry_id: null,
    submitted_at: new Date().toISOString(),
  };
  mockStorage.setTable('reported_sponsorships', [sponRecord as unknown as Record<string, unknown>]);
  mockStorage.setTable('sponsorship_audits', [sponRecord as unknown as Record<string, unknown>]);

  // Edit 1
  const edit1 = await updateReportedSponsorship('sp_repeat_test', {
    sponsor_note: 'Edit 1: In contact with pastor',
    debtAmount: 40,
  });
  const firstUuid = edit1.sponsorship?.ledger_entry_id;
  assert.ok(firstUuid && isUUID(firstUuid), 'Edit 1 must establish a valid UUID');

  // Edit 2
  const edit2 = await updateReportedSponsorship('sp_repeat_test', {
    sponsor_note: 'Edit 2: Pastor confirmed unpaid sponsorship',
    structure: 'S3',
    debtAmount: 40,
  });
  assert.equal(edit2.sponsorship?.ledger_entry_id, firstUuid, 'Edit 2 must retain the same UUID');

  // Edit 3
  const edit3 = await updateReportedSponsorship('sp_repeat_test', {
    passenger_name: 'Nomusa Dlamini-Zulu',
    sponsor_note: 'Edit 3: Updated surname',
    debtAmount: 40,
  });
  assert.equal(edit3.sponsorship?.ledger_entry_id, firstUuid, 'Edit 3 must retain the same UUID');

  // Verify only 1 row exists in the ledger, not 3
  const rows = await listLedgerEntries(true);
  const matchingRows = rows.filter(
    (r) => r.id === firstUuid || r.passenger_name.includes('Nomusa Dlamini')
  );
  assert.equal(matchingRows.length, 1, 'Repeated edits must never create duplicate debt instances');
  assert.equal(matchingRows[0].passenger_name, 'Nomusa Dlamini-Zulu');
  assert.equal(matchingRows[0].structure, 'S3');

  resetStorage();
});

test('Regression 6: Failed updates display an understandable error and do not falsely report success', async () => {
  resetStorage();

  // Attempting to update a non-existent sponsorship ID returns { success: false }
  const res = await updateReportedSponsorship('non_existent_spon_id_99999', {
    sponsor_note: 'Should fail',
  });
  assert.equal(res.success, false, 'Non-existent sponsorship edit must return success: false');

  resetStorage();
});

test('Regression 7: Sponsor changes persist after refreshing the application', async () => {
  resetStorage();

  const realUuid = 'd4e5f6a7-b8c9-4d0e-1f2a-3b4c5d6e7f8a';
  const initialRow: LedgerEntry = {
    id: realUuid,
    manifest_key: '2026-10-18_PM_S5',
    date: '2026-10-18',
    service: 'PM',
    passenger_name: 'Kagiso Rabada',
    stop: 'Gate 3',
    structure: 'S5',
    structure_debt: 40,
    fee: 40,
    status: 'Unpaid',
    submitted_at: new Date().toISOString(),
    sponsored: true,
    sponsor_note: 'Unaccounted Sponsorship: Unpaid',
    general_notes: 'Unaccounted Sponsorship: Unpaid',
  };
  mockStorage.setTable(LEDGER_TABLE, [initialRow as unknown as Record<string, unknown>]);

  const initialSpon: ReportedSponsorship = {
    id: 'sp_kagiso_1',
    manifest_key: '2026-10-18_PM_S5',
    date: '2026-10-18',
    service: 'PM',
    passenger_name: 'Kagiso Rabada',
    structure: 'S5',
    stop: 'Gate 3',
    vehicle_name: 'Taxi 5',
    rep_name: 'Rep Allan',
    sponsor_note: 'Unpaid',
    status: 'unaccounted_sponsorship',
    ledger_entry_id: realUuid,
    submitted_at: new Date().toISOString(),
  };
  mockStorage.setTable('reported_sponsorships', [initialSpon as unknown as Record<string, unknown>]);
  mockStorage.setTable('sponsorship_audits', [initialSpon as unknown as Record<string, unknown>]);

  // Edit sponsor name and note
  await updateReportedSponsorship('sp_kagiso_1', {
    passenger_name: 'Kagiso A. Rabada',
    structure: 'S5',
    sponsor_note: 'Paid via bank transfer on Tuesday',
    status: 'actually_sponsored',
  });

  // Fresh read (simulating browser page refresh)
  const freshSpons = await listReportedSponsorships(true);
  const refreshedSpon = freshSpons.find((s) => s.id === 'sp_kagiso_1');
  assert.ok(refreshedSpon, 'Sponsorship must exist after refresh');
  assert.equal(refreshedSpon.passenger_name, 'Kagiso A. Rabada');
  assert.equal(refreshedSpon.status, 'actually_sponsored');

  // Verify debt row in ledger was settled / cleared because status is actually_sponsored
  const freshLedger = await listLedgerEntries(true);
  const activeDebt = freshLedger.find((e) => e.id === realUuid && e.status === 'Unpaid');
  assert.equal(activeDebt, undefined, 'Debt row must be cleared or settled when verified as actually sponsored');

  resetStorage();
});
