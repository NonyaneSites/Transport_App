import test from 'node:test';
import assert from 'node:assert/strict';
import { generateReconciliationReport, BASELINE_OCT_12_INFO } from './ledgerReconciliation';
import type { LedgerEntry } from './ledger';

test('Reconciliation: Evaluates metrics against 12 October baseline benchmark', () => {
  assert.strictEqual(BASELINE_OCT_12_INFO.debtors, 938);
  assert.strictEqual(BASELINE_OCT_12_INFO.totalDebt, 51425);
  assert.strictEqual(BASELINE_OCT_12_INFO.date, '2026-10-12');

  const testEntries: LedgerEntry[] = [
    {
      id: '1',
      manifest_key: '2026-05-03_PM',
      date: '2026-05-03',
      service: 'PM',
      passenger_name: 'Mandisa Gumede',
      stop: '56 Jorissen',
      structure: 'S1',
      vehicle_name: 'Bus 1',
      submitted_by: 'Cancellation Admin',
      submitted_at: '2026-05-03T18:00:00Z',
      sponsored: true,
      sponsor_note: 'Unaccounted Sponsorship: Sponsorship',
      license_plate: '',
      rep_name: '',
      structure_debt: 40,
      general_notes: 'Unaccounted Sponsorship: Sponsorship',
      source: 'reported_sponsorship_audit',
    },
    {
      id: '2',
      manifest_key: '2026-08-02_PM',
      date: '2026-08-02',
      service: 'PM',
      passenger_name: 'Mandisa Gumede',
      stop: '56 Jorissen',
      structure: 'S1',
      vehicle_name: 'Bus 1',
      submitted_by: 'Cancellation Admin',
      submitted_at: '2026-08-02T18:00:00Z',
      sponsored: true,
      sponsor_note: 'Unaccounted Sponsorship: Sponsorship',
      license_plate: '',
      rep_name: '',
      structure_debt: 40,
      general_notes: 'Unaccounted Sponsorship: Sponsorship',
      source: 'reported_sponsorship_audit',
    },
    {
      id: '3',
      manifest_key: '2026-05-24_PM',
      date: '2026-05-24',
      service: 'PM',
      passenger_name: 'Bongumusa Shongwe',
      stop: 'Braam',
      structure: 'S1',
      vehicle_name: 'Taxi 2',
      submitted_by: 'Transport Rep',
      submitted_at: '2026-05-24T18:00:00Z',
      sponsored: false,
      sponsor_note: '',
      license_plate: '',
      rep_name: '',
      structure_debt: 40,
      general_notes: '',
    },
    {
      id: '4',
      manifest_key: '2026-09-20_AM',
      date: '2026-09-20',
      service: 'AM',
      passenger_name: 'Tebatso Mathekgane',
      stop: 'UJ Gate 2',
      structure: 'S1',
      vehicle_name: 'Taxi 3',
      submitted_by: 'Cancellation Admin',
      submitted_at: '2026-09-20T18:00:00Z',
      sponsored: false,
      sponsor_note: '',
      license_plate: '',
      rep_name: '',
      structure_debt: 0,
      general_notes: '',
      status: 'Settled',
    },
    {
      id: '5',
      manifest_key: '2026-10-18_AM_Normal',
      date: '2026-10-18',
      service: 'AM Service — Normal Only',
      passenger_name: 'New Rider Post Cutoff',
      stop: 'UJ Gate 2',
      structure: 'S2',
      vehicle_name: 'Taxi 1',
      submitted_by: 'Transport Rep',
      submitted_at: '2026-10-18T18:00:00Z',
      sponsored: false,
      sponsor_note: '',
      license_plate: '',
      rep_name: '',
      structure_debt: 40,
      general_notes: '',
    },
  ];

  const { summary, rows } = generateReconciliationReport(testEntries);

  // Mandisa Gumede's two entries aggregate to R80 under sponsorship
  const mandisaRows = rows.filter((r) => r.passengerName === 'Mandisa Gumede');
  assert.strictEqual(mandisaRows.length, 2);
  assert.strictEqual(mandisaRows[0].category, 'sponsorship_unpaid');
  assert.strictEqual(mandisaRows[1].category, 'sponsorship_unpaid');

  // Bongumusa Shongwe ordinary cancellation
  const bongumusaRows = rows.filter((r) => r.passengerName === 'Bongumusa Shongwe');
  assert.strictEqual(bongumusaRows.length, 1);
  assert.strictEqual(bongumusaRows[0].category, 'cancellation');
  assert.strictEqual(bongumusaRows[0].amount, 40);

  // Tebatso Mathekgane 20/09 is settled
  const tebatsoRow = rows.find((r) => r.passengerName === 'Tebatso Mathekgane');
  assert.ok(tebatsoRow);
  assert.strictEqual(tebatsoRow.status, 'Settled');
  assert.strictEqual(tebatsoRow.classification, 'settled_after_cutoff');

  // New post-cutoff trip is classified as extra_app_charge (legitimate new debt)
  const newRiderRow = rows.find((r) => r.passengerName === 'New Rider Post Cutoff');
  assert.ok(newRiderRow);
  assert.strictEqual(newRiderRow.classification, 'extra_app_charge');

  assert.strictEqual(summary.settledAfterCutoffCount, 1);
});
