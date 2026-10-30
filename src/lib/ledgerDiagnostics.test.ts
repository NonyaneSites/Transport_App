import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyLedgerIdPattern,
  diagnoseCancellationLedgerIds,
} from './ledgerDiagnostics';
import { mockStorage, LEDGER_TABLE } from './supabase';

test('Diagnostic 1: classifyLedgerIdPattern correctly classifies all ID formats', () => {
  // Valid UUIDs
  const uuid1 = '7cf0a93e-0c3e-4bb3-9591-59fba7292096';
  const c1 = classifyLedgerIdPattern(uuid1);
  assert.equal(c1.pattern, 'valid_uuid');
  assert.equal(c1.isUuid, true);

  // Synthetic sponsorship ID
  const syn1 = 'ledger_sp_1791315588039_49p5t';
  const c2 = classifyLedgerIdPattern(syn1);
  assert.equal(c2.pattern, 'synthetic_ledger_sp');
  assert.equal(c2.isUuid, false);

  // Synthetic mock ID
  const mock1 = 'mock_1791234567890_abc123';
  const c3 = classifyLedgerIdPattern(mock1);
  assert.equal(c3.pattern, 'synthetic_mock');
  assert.equal(c3.isUuid, false);

  // Test ID
  const test1 = 'test-rename-persist-1';
  const c4 = classifyLedgerIdPattern(test1);
  assert.equal(c4.pattern, 'synthetic_test');
  assert.equal(c4.isUuid, false);

  // Virtual display ID
  const vspon1 = 'v_spon_1791234567890';
  const c5 = classifyLedgerIdPattern(vspon1);
  assert.equal(c5.pattern, 'synthetic_v_spon');
  assert.equal(c5.isUuid, false);

  // Empty or null
  const empty1 = classifyLedgerIdPattern('');
  assert.equal(empty1.pattern, 'empty_or_null');
  assert.equal(empty1.isUuid, false);

  const null1 = classifyLedgerIdPattern(null);
  assert.equal(null1.pattern, 'empty_or_null');
  assert.equal(null1.isUuid, false);

  // Other malformed
  const other1 = classifyLedgerIdPattern('12345');
  assert.equal(other1.pattern, 'other_malformed');
  assert.equal(other1.isUuid, false);
});

test('Diagnostic 2: diagnoseCancellationLedgerIds accurately inspects and categorizes rows', async () => {
  const sampleRows = [
    {
      id: '25714bf1-e34e-4f36-8280-a3d76f5cc4fd',
      passenger_name: 'Valid Rider 1',
      structure: 'S1',
      date: '2026-10-25',
      status: 'Unpaid',
      structure_debt: 40,
    },
    {
      id: 'a1b2c3d4-e5f6-4a5b-8c9d-0e1f2a3b4c5d',
      passenger_name: 'Valid Rider 2',
      structure: 'S2',
      date: '2026-10-25',
      status: 'Unpaid',
      structure_debt: 40,
    },
    {
      id: 'ledger_sp_1791315588039_49p5t',
      passenger_name: 'Suspicious Rider 1',
      structure: 'S3',
      date: '2026-10-25',
      status: 'Unpaid',
      structure_debt: 40,
    },
    {
      id: 'mock_1791315588039_abcdef',
      passenger_name: 'Mock Test Rider',
      structure: 'S4',
      date: '2026-10-25',
      status: 'Unpaid',
      structure_debt: 40,
    },
    {
      id: '',
      passenger_name: 'Empty ID Rider',
      structure: 'S5',
      date: '2026-10-25',
      status: 'Unpaid',
      structure_debt: 40,
    },
  ];

  const report = await diagnoseCancellationLedgerIds(sampleRows);

  assert.equal(report.totalRecords, 5);
  assert.equal(report.validUuidCount, 2);
  assert.equal(report.malformedCount, 3);
  assert.equal(report.validUuidPercentage, 40);

  assert.equal(report.byPattern.syntheticLedgerSp, 1);
  assert.equal(report.byPattern.syntheticMock, 1);
  assert.equal(report.byPattern.emptyOrNull, 1);

  assert.equal(report.suspiciousRows.length, 3);
  assert.equal(report.suspiciousRows[0].id, 'ledger_sp_1791315588039_49p5t');
  assert.equal(report.suspiciousRows[0].pattern, 'synthetic_ledger_sp');
});

test('Diagnostic 3: diagnoseCancellationLedgerIds inspects Supabase mockStorage table when called with no arguments', async () => {
  mockStorage.setTable(LEDGER_TABLE, [
    {
      id: 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e',
      passenger_name: 'Db Person A',
      structure: 'S1',
      date: '2026-10-20',
      status: 'Unpaid',
      structure_debt: 40,
    },
    {
      id: 'c2d3e4f5-a6b7-4c8d-9e0f-1a2b3c4d5e6f',
      passenger_name: 'Db Person B',
      structure: 'S2',
      date: '2026-10-20',
      status: 'Unpaid',
      structure_debt: 40,
    },
  ]);

  const report = await diagnoseCancellationLedgerIds();

  assert.equal(report.totalRecords, 2);
  assert.equal(report.validUuidCount, 2);
  assert.equal(report.malformedCount, 0);
  assert.equal(report.validUuidPercentage, 100);
  assert.equal(report.suspiciousRows.length, 0);
});
