import { supabase, LEDGER_TABLE } from './supabase';

export type LedgerIdPatternType =
  | 'valid_uuid'
  | 'synthetic_ledger_sp'
  | 'synthetic_mock'
  | 'synthetic_test'
  | 'synthetic_v_spon'
  | 'empty_or_null'
  | 'other_malformed';

export interface LedgerIdDiagnosticItem {
  id: string;
  pattern: LedgerIdPatternType;
  passenger_name: string;
  structure: string;
  date: string;
  service?: string;
  status: string;
  structure_debt: unknown;
  fee: unknown;
  isUuid: boolean;
  description: string;
}

export interface LedgerIdDiagnosticReport {
  timestamp: string;
  source: 'supabase' | 'provided' | 'fallback';
  totalRecords: number;
  validUuidCount: number;
  malformedCount: number;
  validUuidPercentage: number;
  byPattern: {
    syntheticLedgerSp: number;
    syntheticMock: number;
    syntheticTest: number;
    syntheticVSpon: number;
    emptyOrNull: number;
    otherMalformed: number;
  };
  suspiciousRows: LedgerIdDiagnosticItem[];
  validRowsCount: number;
}

/**
 * Classifies an identifier string into standard RFC4122 UUID vs. specific suspicious/malformed patterns.
 */
export function classifyLedgerIdPattern(id: unknown): {
  pattern: LedgerIdPatternType;
  isUuid: boolean;
  description: string;
} {
  if (id === null || id === undefined || String(id).trim() === '') {
    return {
      pattern: 'empty_or_null',
      isUuid: false,
      description: 'Missing or empty identifier',
    };
  }

  const str = String(id).trim();

  // RFC 4122 UUID: 8-4-4-4-12 hex digits
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str)) {
    return {
      pattern: 'valid_uuid',
      isUuid: true,
      description: 'Standard PostgreSQL RFC4122 UUID',
    };
  }

  if (/^ledger_sp_/i.test(str)) {
    return {
      pattern: 'synthetic_ledger_sp',
      isUuid: false,
      description: 'Synthetic sponsorship ID (e.g. ledger_sp_<timestamp>_<random>)',
    };
  }

  if (/^mock_/i.test(str)) {
    return {
      pattern: 'synthetic_mock',
      isUuid: false,
      description: 'In-memory test/mock runner identifier (e.g. mock_<timestamp>)',
    };
  }

  if (/^test[-_]/i.test(str)) {
    return {
      pattern: 'synthetic_test',
      isUuid: false,
      description: 'Automated test suite identifier (e.g. test-rename-persist)',
    };
  }

  if (/^v_spon_/i.test(str)) {
    return {
      pattern: 'synthetic_v_spon',
      isUuid: false,
      description: 'Frontend virtual display ID for unmapped sponsorship',
    };
  }

  return {
    pattern: 'other_malformed',
    isUuid: false,
    description: `Non-UUID malformed identifier (${str.length > 30 ? str.slice(0, 30) + '…' : str})`,
  };
}

/**
 * Diagnostic utility function to inspect the current state of the cancellation_ledger table,
 * specifically logging rows with suspicious ID patterns to identify how many records contain
 * malformed vs. actual UUIDs.
 *
 * @param customRows Optional array of records to inspect. If omitted, queries cancellation_ledger directly.
 * @param options.silent If true, suppresses console logging.
 * @returns Comprehensive diagnostic report breakdown.
 */
export async function diagnoseCancellationLedgerIds(
  customRows?: unknown[],
  options?: { silent?: boolean }
): Promise<LedgerIdDiagnosticReport> {
  const silent = Boolean(options?.silent);
  let rows: Array<Record<string, unknown>> = [];
  let source: 'supabase' | 'provided' | 'fallback' = 'provided';

  if (Array.isArray(customRows)) {
    rows = customRows as Array<Record<string, unknown>>;
    source = 'provided';
  } else {
    try {
      // Query cancellation_ledger table from Supabase
      const allFetched: Array<Record<string, unknown>> = [];
      const pageSize = 1000;
      let from = 0;

      while (true) {
        const { data, error } = await supabase
          .from(LEDGER_TABLE)
          .select('id, passenger_name, structure, date, service, status, structure_debt, fee, manifest_key, submitted_at')
          .range(from, from + pageSize - 1);

        if (error) {
          console.warn('[Ledger Diagnostics] Supabase query note:', error.message);
          break;
        }
        if (!data || data.length === 0) break;
        allFetched.push(...data);
        if (data.length < pageSize) break;
        from += pageSize;
      }

      if (allFetched.length > 0) {
        rows = allFetched;
        source = 'supabase';
      } else {
        source = 'fallback';
      }
    } catch (err) {
      console.warn('[Ledger Diagnostics] Could not fetch directly from Supabase, attempting fallback:', err);
      source = 'fallback';
    }
  }

  let validUuidCount = 0;
  let syntheticLedgerSp = 0;
  let syntheticMock = 0;
  let syntheticTest = 0;
  let syntheticVSpon = 0;
  let emptyOrNull = 0;
  let otherMalformed = 0;

  const suspiciousRows: LedgerIdDiagnosticItem[] = [];

  for (const r of rows) {
    const rawId = r?.id;
    const { pattern, isUuid, description } = classifyLedgerIdPattern(rawId);

    const item: LedgerIdDiagnosticItem = {
      id: rawId != null ? String(rawId) : '',
      pattern,
      passenger_name: String(r?.passenger_name ?? '—'),
      structure: String(r?.structure ?? '—'),
      date: String(r?.date ?? '—'),
      service: r?.service ? String(r.service) : undefined,
      status: String(r?.status ?? 'Unpaid'),
      structure_debt: r?.structure_debt,
      fee: r?.fee,
      isUuid,
      description,
    };

    if (isUuid) {
      validUuidCount++;
    } else {
      suspiciousRows.push(item);
      switch (pattern) {
        case 'synthetic_ledger_sp':
          syntheticLedgerSp++;
          break;
        case 'synthetic_mock':
          syntheticMock++;
          break;
        case 'synthetic_test':
          syntheticTest++;
          break;
        case 'synthetic_v_spon':
          syntheticVSpon++;
          break;
        case 'empty_or_null':
          emptyOrNull++;
          break;
        case 'other_malformed':
        default:
          otherMalformed++;
          break;
      }
    }
  }

  const totalRecords = rows.length;
  const malformedCount = suspiciousRows.length;
  const validUuidPercentage = totalRecords > 0 ? Number(((validUuidCount / totalRecords) * 100).toFixed(2)) : 100;

  const report: LedgerIdDiagnosticReport = {
    timestamp: new Date().toISOString(),
    source,
    totalRecords,
    validUuidCount,
    malformedCount,
    validUuidPercentage,
    byPattern: {
      syntheticLedgerSp,
      syntheticMock,
      syntheticTest,
      syntheticVSpon,
      emptyOrNull,
      otherMalformed,
    },
    suspiciousRows,
    validRowsCount: validUuidCount,
  };

  // Structured logging
  if (!silent) {
    const logHeader = `[Cancellation Ledger ID Diagnostic] Inspected ${totalRecords} records (Source: ${source})`;
    if (typeof console.group === 'function') {
      console.group(logHeader);
    } else {
      console.log(logHeader);
    }

    console.info(`✓ Valid RFC4122 UUIDs: ${validUuidCount} / ${totalRecords} (${validUuidPercentage}%)`);

    if (malformedCount > 0) {
      console.warn(`⚠️ Malformed / Suspicious IDs Found: ${malformedCount}`);
      console.warn(`   • Synthetic ledger_sp_...: ${syntheticLedgerSp}`);
      console.warn(`   • Synthetic mock_...:      ${syntheticMock}`);
      console.warn(`   • Test identifiers:        ${syntheticTest}`);
      console.warn(`   • Virtual display v_spon_: ${syntheticVSpon}`);
      console.warn(`   • Empty or null IDs:       ${emptyOrNull}`);
      console.warn(`   • Other malformed strings: ${otherMalformed}`);

      console.warn('[Ledger Diagnostics] List of suspicious rows:');
      if (typeof console.table === 'function') {
        console.table(
          suspiciousRows.map((row) => ({
            ID: row.id,
            Pattern: row.pattern,
            Passenger: row.passenger_name,
            Structure: row.structure,
            Date: row.date,
            Status: row.status,
            Debt: row.structure_debt,
          }))
        );
      } else {
        suspiciousRows.forEach((row, idx) => {
          console.warn(`  #${idx + 1} ID: "${row.id}" | Pattern: ${row.pattern} | Name: ${row.passenger_name} | Date: ${row.date} | Status: ${row.status}`);
        });
      }
    } else {
      console.info('🎉 100% ID Integrity: All cancellation_ledger records have valid PostgreSQL UUIDs.');
    }

    if (typeof console.groupEnd === 'function') {
      console.groupEnd();
    }
  }

  return report;
}

// Attach to window object for convenient browser console diagnostics
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__diagnoseLedgerIds = diagnoseCancellationLedgerIds;
  (window as unknown as Record<string, unknown>).diagnoseCancellationLedgerIds = diagnoseCancellationLedgerIds;
}
