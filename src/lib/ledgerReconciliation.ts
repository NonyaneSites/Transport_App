import type { LedgerEntry } from './ledger';
import { aggregateLedgerEntries, parseDebtAmount } from './ledger';
import { normalizeStructureCode } from './ledger';

export interface ReconciliationSummary {
  baselineDate: string;
  baselineDebtorsReported: number;
  baselineTotalDebtReported: number;
  currentActiveDebtorsCount: number;
  currentActiveTotalDebt: number;
  asOfCutoffDebtorsCount: number;
  asOfCutoffTotalDebt: number;
  settledAfterCutoffCount: number;
  settledAfterCutoffTotal: number;
  classifiedCounts: Record<string, number>;
}

export interface ReconciliationRow {
  id: string;
  passengerName: string;
  structure: string;
  date: string;
  service: string;
  category: 'cancellation' | 'sponsorship_unpaid';
  amount: number;
  status: 'Active' | 'Settled';
  classification:
    | 'matches'
    | 'extra_app_charge'
    | 'altered_amount'
    | 'category_mismatch'
    | 'settled_after_cutoff'
    | 'duplicate'
    | 'ambiguous_identity'
    | 'unverified';
  notes: string;
  provenance: string;
}

export const BASELINE_OCT_12_INFO = {
  date: '2026-10-12',
  debtors: 938,
  totalDebt: 51425,
  description: 'CRC Cancellation Debt List as of 12 October 2026 (31 pages, 938 debtors, R51,425 reported outstanding)',
};

/**
 * Builds row-by-row reconciliation analysis comparing ledger entries as of 12 October 2026 cutoff.
 */
export function generateReconciliationReport(entries: LedgerEntry[]): {
  summary: ReconciliationSummary;
  rows: ReconciliationRow[];
} {
  const cutoffDate = BASELINE_OCT_12_INFO.date;
  const classifiedCounts: Record<string, number> = {
    matches: 0,
    extra_app_charge: 0,
    altered_amount: 0,
    category_mismatch: 0,
    settled_after_cutoff: 0,
    duplicate: 0,
    ambiguous_identity: 0,
    unverified: 0,
  };

  const nameDateOccurrences = new Map<string, number>();
  for (const e of entries) {
    const key = `${(e.passenger_name || '').trim().toLowerCase()}:::${e.date || ''}`;
    nameDateOccurrences.set(key, (nameDateOccurrences.get(key) || 0) + 1);
  }

  const rows: ReconciliationRow[] = [];
  let asOfCutoffTotalDebt = 0;
  const asOfCutoffDebtorSet = new Set<string>();
  let settledAfterCutoffCount = 0;
  let settledAfterCutoffTotal = 0;

  for (const e of entries) {
    const d = e.date || (e.manifest_key ? String(e.manifest_key).split('_')[0] : '');
    const cleanName = (e.passenger_name || '').trim();
    const normStructure = normalizeStructureCode(e.structure);
    const amount = parseDebtAmount(e.structure_debt, d, e.service, e.legs);
    const isSettled = e.status === 'Settled' || e.status === 'Paid' || amount <= 0;
    const isSponOrUnpaid = Boolean(
      e.sponsored ||
      (e.general_notes && /unaccounted|did not pay|unpaid|sponsorship/i.test(e.general_notes)) ||
      (e.sponsor_note && /unaccounted|did not pay|unpaid|sponsorship/i.test(e.sponsor_note))
    );

    const nameKey = `${cleanName.toLowerCase()}:::${d}`;
    const duplicateCount = nameDateOccurrences.get(nameKey) || 1;

    let classification: ReconciliationRow['classification'] = 'matches';

    if (isSettled) {
      classification = 'settled_after_cutoff';
      settledAfterCutoffCount++;
      settledAfterCutoffTotal += (amount || 40);
    } else if (duplicateCount > 1) {
      classification = 'duplicate';
    } else if (d > cutoffDate) {
      classification = 'extra_app_charge';
    } else if (amount !== 40 && amount !== 45 && amount !== 70) {
      classification = 'altered_amount';
    } else if (isSponOrUnpaid && (e.general_notes?.includes('Sponsorship') || e.sponsor_note?.includes('Sponsorship'))) {
      classification = 'category_mismatch';
    } else {
      classification = 'matches';
    }

    classifiedCounts[classification] = (classifiedCounts[classification] || 0) + 1;

    if (!isSettled && d <= cutoffDate) {
      asOfCutoffTotalDebt += amount;
      asOfCutoffDebtorSet.add(cleanName.toLowerCase());
    }

    rows.push({
      id: e.id,
      passengerName: cleanName,
      structure: normStructure,
      date: d,
      service: e.service || 'Service',
      category: isSponOrUnpaid ? 'sponsorship_unpaid' : 'cancellation',
      amount,
      status: isSettled ? 'Settled' : 'Active',
      classification,
      notes: e.general_notes || e.sponsor_note || '',
      provenance: e.source || (e.manifest_key ? `manifest:${e.manifest_key}` : 'cancellation_ledger'),
    });
  }

  // Active ledger overall
  const activeGroups = aggregateLedgerEntries(entries);
  const currentActiveDebtorsCount = activeGroups.reduce((sum, g) => sum + g.rows.length, 0);
  const currentActiveTotalDebt = activeGroups.reduce((sum, g) => sum + g.totalDebt, 0);

  const summary: ReconciliationSummary = {
    baselineDate: cutoffDate,
    baselineDebtorsReported: BASELINE_OCT_12_INFO.debtors,
    baselineTotalDebtReported: BASELINE_OCT_12_INFO.totalDebt,
    currentActiveDebtorsCount,
    currentActiveTotalDebt,
    asOfCutoffDebtorsCount: asOfCutoffDebtorSet.size,
    asOfCutoffTotalDebt,
    settledAfterCutoffCount,
    settledAfterCutoffTotal,
    classifiedCounts,
  };

  return { summary, rows };
}

/**
 * Generates and triggers download of a detailed Reconciliation CSV file.
 */
export function downloadReconciliationCsv(entries: LedgerEntry[]): void {
  const { summary, rows } = generateReconciliationReport(entries);

  const header = [
    'Debtor ID',
    'Passenger Name',
    'Structure',
    'Session Date',
    'Service',
    'Category',
    'Amount (ZAR)',
    'Status',
    'Reconciliation Classification',
    'Notes',
    'Data Provenance',
  ];

  const csvRows: string[][] = [];

  // Summary lines at top
  csvRows.push(['# CRC Transport Ministry — 12 October 2026 Historical Ledger Reconciliation Report']);
  csvRows.push([`# Baseline Reference Date: ${summary.baselineDate}`]);
  csvRows.push([`# 12 Oct Baseline Benchmark: ${summary.baselineDebtorsReported} debtors | R${summary.baselineTotalDebtReported} total`]);
  csvRows.push([`# As-Of-Cutoff App Total: ${summary.asOfCutoffDebtorsCount} debtors | R${summary.asOfCutoffTotalDebt} total`]);
  csvRows.push([`# Active Overall App Total: ${summary.currentActiveDebtorsCount} debtors | R${summary.currentActiveTotalDebt} total`]);
  csvRows.push([]);
  csvRows.push(header);

  for (const r of rows) {
    csvRows.push([
      `"${r.id}"`,
      `"${r.passengerName.replace(/"/g, '""')}"`,
      `"${r.structure}"`,
      `"${r.date}"`,
      `"${r.service.replace(/"/g, '""')}"`,
      `"${r.category}"`,
      String(r.amount),
      `"${r.status}"`,
      `"${r.classification}"`,
      `"${(r.notes || '').replace(/"/g, '""')}"`,
      `"${r.provenance.replace(/"/g, '""')}"`,
    ]);
  }

  const csvContent = csvRows.map((line) => line.join(',')).join('\r\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `CRC_Cancellation_Reconciliation_Report_${summary.baselineDate}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
