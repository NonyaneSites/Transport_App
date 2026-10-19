import test from 'node:test';
import assert from 'node:assert/strict';
import { generateReconciliationReport, BASELINE_OCT_12_INFO } from './ledgerReconciliation';
import type { LedgerEntry } from './ledger';

function debt(id: string, name: string, date: string, amount: number, category: 'cancellation' | 'sponsorship_unpaid' = 'cancellation'): LedgerEntry {
  return {
    id, manifest_key: `${date}_PM_Normal`, date, service: 'PM',
    passenger_name: name, stop: '', structure: 'S1', vehicle_name: 'Taxi',
    submitted_by: 'Rep', submitted_at: `${date}T12:00:00Z`,
    sponsored: category === 'sponsorship_unpaid', sponsor_note: category === 'sponsorship_unpaid' ? 'Unaccounted Sponsorship' : '',
    rep_name: '', license_plate: '', structure_debt: amount,
    general_notes: category === 'sponsorship_unpaid' ? 'Unaccounted Sponsorship' : '',
  };
}

test('Historic PDF was extracted in full', () => {
  assert.equal(BASELINE_OCT_12_INFO.debtors, 938);
  assert.equal(BASELINE_OCT_12_INFO.totalDebt, 51425);
});

test('Exact match requires correct category, amount AND individual sessions', () => {
  const rows = [
    debt('1', 'Mandisa Gumede', '2026-05-03', 40, 'sponsorship_unpaid'),
    debt('2', 'Mandisa Gumede', '2026-08-02', 40, 'sponsorship_unpaid'),
    debt('3', 'Bongumusa Shongwe', '2026-05-24', 40),
    { ...debt('4', 'Bongumusa Shongwe', '2026-05-24', 40), status: 'Settled', structure_debt: 0 },
    debt('5', 'New Rider', '2026-10-18', 40),
  ];
  const { summary, rows: report } = generateReconciliationReport(rows);
  const mandisa = report.find(r => r.passengerName === 'Mandisa Gumede' && r.category === 'sponsorship_unpaid');
  assert.equal(mandisa?.classification, 'matches');
  assert.equal(mandisa?.referenceAmount, 80);
  const bongumusa = report.find(r => r.passengerName === 'Bongumusa Shongwe' && r.category === 'cancellation');
  assert.equal(bongumusa?.classification, 'matches');
  assert.equal(bongumusa?.amount, 40);
  assert.equal(report.find(r => r.passengerName === 'New Rider')?.classification, 'post_cutoff');
  assert.equal(summary.currentActiveTotalDebt, 160);
  assert.equal(summary.settledAfterCutoffCount, 0); // settlement history isn't in the active feed
});

test('Do not assume an absent reference entry is a confirmed payment', () => {
  const { rows } = generateReconciliationReport([]);
  assert.ok(rows.some(r => r.classification === 'missing_from_app'));
  assert.ok(rows.every(r => r.status !== 'Active'));
});

test('A listed rider with a wrong fare is explicitly flagged', () => {
  const { rows } = generateReconciliationReport([debt('1', 'Bongumusa Shongwe', '2026-05-24', 15)]);
  assert.equal(rows.find(r => r.passengerName === 'Bongumusa Shongwe' && r.category === 'cancellation')?.classification, 'altered_amount');
});
