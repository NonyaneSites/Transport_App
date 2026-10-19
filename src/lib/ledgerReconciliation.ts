import type { LedgerEntry } from './ledger';
import {
  aggregateLedgerEntries,
  normalizeStructureCode,
} from './ledger';
import sourceReference from '@/data/official_oct12_reference.json';

type Category = 'cancellation' | 'sponsorship_unpaid';
interface ReferenceRow {
  structure: string;
  category: string;
  name: string;
  missed_sessions: string[];
  amount: number;
  pdf_line: number;
}

export const BASELINE_OCT_12_INFO = {
  date: '2026-10-12',
  debtors: 938,
  totalDebt: 51425,
  description: 'Official 12 October 2026 PDF, 31 pages, 938 listed rows, R51,425 outstanding',
};

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
  category: Category;
  amount: number;
  referenceAmount: number;
  difference: number;
  expectedSessions: string;
  actualSessions: string;
  status: 'Active' | 'Not in active app';
  classification:
    | 'matches'
    | 'extra_app_charge'
    | 'post_cutoff'
    | 'altered_amount'
    | 'session_mismatch'
    | 'category_mismatch'
    | 'missing_from_app'
    | 'unverified';
  notes: string;
  provenance: string;
}

const referenceRows = sourceReference.rows as ReferenceRow[];
const referenceSum = referenceRows.reduce((n, r) => n + r.amount, 0);
if (referenceRows.length !== BASELINE_OCT_12_INFO.debtors || referenceSum !== BASELINE_OCT_12_INFO.totalDebt) {
  throw new Error('The historical PDF reference is incomplete; reconciliation is disabled.');
}

function normName(name: string): string {
  return name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}
function identity(structure: string, name: string, category: Category): string {
  return `${normalizeStructureCode(structure).toLowerCase()}::${normName(name)}::${category}`;
}
function normalizeSession(session: string): string {
  return session.replace(/\s+/g, ' ').trim().toUpperCase();
}
function dateOfSession(value: string): string {
  const m = value.match(/^(\d{2})\/(\d{2})\/(\d{2})/);
  return m ? `20${m[3]}-${m[2]}-${m[1]}` : '';
}
function normalizedSessions(values: string[]): string[] {
  return values.map(normalizeSession).sort();
}
function categoryForReference(value: string): Category {
  return value === 'cancellation' ? 'cancellation' : 'sponsorship_unpaid';
}

/**
 * A REAL row-level historical audit. The PDF entries are matched using the
 * structure, normalized debtor name, debt category, amount and EVERY listed
 * date/session, not merely against a hard-coded grand total. An old debt that
 * is absent from the PDF is flagged for admin review, not labelled 'paid'.
 *
 * The PDF is as at 12 October. A later payment can legitimately make today's
 * total smaller; newer genuine charges can make it larger. Never auto-rewrite
 * financial history from a snapshot.
 */
export function generateReconciliationReport(entries: LedgerEntry[]): {
  summary: ReconciliationSummary;
  rows: ReconciliationRow[];
} {
  const expected = new Map<string, { structure: string; name: string; category: Category; amount: number; sessions: string[]; lines: number[] }>();
  for (const row of referenceRows) {
    const category = categoryForReference(row.category);
    const key = identity(row.structure, row.name, category);
    const existing = expected.get(key) || { structure: row.structure, name: row.name, category, amount: 0, sessions: [], lines: [] };
    existing.amount += row.amount;
    existing.sessions.push(...row.missed_sessions);
    existing.lines.push(row.pdf_line);
    expected.set(key, existing);
  }

  const groups = aggregateLedgerEntries(entries);
  const active = new Map<string, { structure: string; name: string; category: Category; amount: number; sessions: string[]; ids: string[]; dates: string[] }>();
  const cutoff = BASELINE_OCT_12_INFO.date;
  let currentActiveTotalDebt = 0;
  let currentActiveDebtorsCount = 0;
  let asOfCutoffTotalDebt = 0;
  const cutoffIdentities = new Set<string>();

  for (const group of groups) {
    for (const row of group.rows) {
      currentActiveTotalDebt += row.amount;
      currentActiveDebtorsCount++;
      const category: Category = row.isSponsorshipOrUnpaid ? 'sponsorship_unpaid' : 'cancellation';
      const key = identity(row.structure, row.name, category);
      const existing = active.get(key) || { structure: row.structure, name: row.name, category, amount: 0, sessions: [], ids: [], dates: [] };
      // Compare the 12 Oct snapshot only with service dates up to the cutoff.
      for (const instance of row.instances) {
        if (instance.date <= cutoff) {
          existing.amount += instance.amount;
          existing.sessions.push(instance.formatted);
          existing.dates.push(instance.date);
          existing.ids.push(instance.id);
          asOfCutoffTotalDebt += instance.amount;
          cutoffIdentities.add(key);
        }
      }
      if (existing.ids.length > 0) active.set(key, existing);
    }
  }

  const classifiedCounts: Record<string, number> = {
    matches: 0,
    extra_app_charge: 0,
    post_cutoff: 0,
    altered_amount: 0,
    session_mismatch: 0,
    category_mismatch: 0,
    missing_from_app: 0,
    unverified: 0,
  };
  const rows: ReconciliationRow[] = [];
  const keys = new Set([...expected.keys(), ...active.keys()]);

  for (const key of keys) {
    const ref = expected.get(key);
    const live = active.get(key);
    const otherCategory: Category = (ref || live)?.category === 'cancellation' ? 'sponsorship_unpaid' : 'cancellation';
    const matchingNameOtherCategory = Boolean((ref || live) && (
      active.has(identity((ref || live)!.structure, (ref || live)!.name, otherCategory)) ||
      expected.has(identity((ref || live)!.structure, (ref || live)!.name, otherCategory))
    ));
    let classification: ReconciliationRow['classification'];
    if (!ref) classification = matchingNameOtherCategory ? 'category_mismatch' : 'extra_app_charge';
    else if (!live) classification = matchingNameOtherCategory ? 'category_mismatch' : 'missing_from_app';
    else if (ref.amount !== live.amount) classification = 'altered_amount';
    else if (JSON.stringify(normalizedSessions(ref.sessions)) !== JSON.stringify(normalizedSessions(live.sessions))) classification = 'session_mismatch';
    else classification = 'matches';

    classifiedCounts[classification]++;
    const source = ref || live!;
    rows.push({
      id: live?.ids.join(';') || '',
      passengerName: source.name,
      structure: source.structure,
      date: live?.dates[0] || (ref?.sessions[0] && dateOfSession(ref.sessions[0])) || '',
      service: live?.sessions.join(', ') || ref?.sessions.join(', ') || '',
      category: source.category,
      amount: live?.amount ?? 0,
      referenceAmount: ref?.amount ?? 0,
      difference: (live?.amount ?? 0) - (ref?.amount ?? 0),
      expectedSessions: ref?.sessions.join(', ') || '',
      actualSessions: live?.sessions.join(', ') || '',
      status: live ? 'Active' : 'Not in active app',
      classification,
      notes: !ref ? 'Not present in 12 Oct snapshot. Review settlement or later admin changes.'
        : !live ? 'No active match; may have been paid AFTER the snapshot. Verify settlement log before restoring.'
          : classification === 'altered_amount' ? 'Check partial payment(s) and per-trip balances.'
            : classification === 'session_mismatch' ? 'Total agrees, but the listed trip dates or services differ.' : '',
      provenance: ref ? `official PDF (row(s) beginning at PDF-extracted line ${ref.lines.join('/')})` : 'active ledger',
    });
  }

  // Actual post-cutoff debts are valid changes, not errors against the PDF.
  for (const group of groups) {
    for (const row of group.rows) {
      const future = row.instances.filter(inst => inst.date > cutoff);
      if (!future.length) continue;
      classifiedCounts.post_cutoff++;
      rows.push({
        id: future.map(i => i.id).join(';'),
        passengerName: row.name,
        structure: row.structure,
        date: future[0].date,
        service: future.map(i => i.formatted).join(', '),
        category: row.isSponsorshipOrUnpaid ? 'sponsorship_unpaid' : 'cancellation',
        amount: future.reduce((n, i) => n + i.amount, 0),
        referenceAmount: 0,
        difference: 0,
        expectedSessions: '',
        actualSessions: future.map(i => i.formatted).join(', '),
        status: 'Active',
        classification: 'post_cutoff',
        notes: 'After 12 Oct; do not erase during historical reconciliation.',
        provenance: 'post-cutoff ledger',
      });
    }
  }

  // The normal ledger feed contains ACTIVE rows only. Do not invent how many
  // were paid since the 12 Oct snapshot; that requires the settlement log.
  rows.sort((a, b) => a.structure.localeCompare(b.structure, undefined, { numeric: true }) || a.passengerName.localeCompare(b.passengerName));
  return {
    summary: {
      baselineDate: cutoff,
      baselineDebtorsReported: BASELINE_OCT_12_INFO.debtors,
      baselineTotalDebtReported: BASELINE_OCT_12_INFO.totalDebt,
      currentActiveDebtorsCount,
      currentActiveTotalDebt,
      asOfCutoffDebtorsCount: cutoffIdentities.size,
      asOfCutoffTotalDebt,
      settledAfterCutoffCount: 0,
      settledAfterCutoffTotal: 0,
      classifiedCounts,
    },
    rows,
  };
}

export function downloadReconciliationCsv(entries: LedgerEntry[]): void {
  const { summary, rows } = generateReconciliationReport(entries);
  const csvRows: string[][] = [
    ['CRC 12 October 2026 official PDF reconciliation (NOT a payment register)'],
    [`Reference: ${summary.baselineDebtorsReported} PDF rows / R${summary.baselineTotalDebtReported}`],
    [`Current app charges dated through 12 Oct: R${summary.asOfCutoffTotalDebt}`],
    ['Missing active debt is NOT proof of settlement; reconcile receipts and post-12-Oct activity before editing.'],
    [],
    ['Debtor name', 'Structure', 'Debt category', 'PDF outstanding', 'Active outstanding for pre-13-Oct sessions', 'Difference', 'PDF sessions', 'App sessions', 'Classification', 'Notes', 'Ledger IDs', 'Provenance'],
  ];
  for (const row of rows) {
    csvRows.push([
      row.passengerName, row.structure, row.category, String(row.referenceAmount), String(row.amount), String(row.difference),
      row.expectedSessions, row.actualSessions, row.classification, row.notes, row.id, row.provenance,
    ]);
  }
  const csv = csvRows.map(r => r.map(value => `"${value.replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'CRC_Historical_Debt_Reconciliation_12_Oct_2026.csv';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
