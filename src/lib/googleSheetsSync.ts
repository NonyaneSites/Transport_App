import type { ExtractedVehicleStats } from './statsExport';

/**
 * Pushes submitted-vehicle stats straight into the live "Transport Operations"
 * Google Sheet (same layout as the "Transport Stats Summary" download), via a
 * Google Apps Script Web App acting as a webhook. No Google credentials ever
 * live in this app — the Apps Script deployment holds the connection to the
 * Sheet, and this module just POSTs one row per submitted vehicle to it.
 *
 * Setup: see /google-apps-script/Code.gs and README section "Auto-sync to
 * Google Sheets" for the one-time deployment steps. Once deployed, set
 * VITE_GOOGLE_SHEETS_WEBHOOK_URL (and optionally VITE_GOOGLE_SHEETS_SECRET)
 * in your .env file.
 */

// Column order MUST match the "Stats" tab headers exactly.
export const GOOGLE_SHEET_HEADERS = [
  'Timestamp',
  'Money Collector Name & Surname',
  'Date',
  'Service',
  'Vehicle type',
  'Vehicle Number Plate',
  'Taxi No./Bus No.',
  'Members & Visitors list (Name & Surname - As written when booking)',
  "FTV's List (Name & Surname - As written when booking)",
  'Headcount',
  'Total Money Collected ',
  'Money Outstanding/extra ',
  'Cancellations (Full name incl. Structure)',
  'Sponsorships (Name, Surname and Structure)',
  'Additional notes (People paying for others, Cancellations being paid etc.)',
] as const;

export interface GoogleSheetRowPayload {
  secret?: string;
  sheetName?: string;
  row: (string | number)[];
}

const WEBHOOK_URL = (import.meta.env.VITE_GOOGLE_SHEETS_WEBHOOK_URL as string | undefined)?.trim();
const SHEET_SECRET = (import.meta.env.VITE_GOOGLE_SHEETS_SECRET as string | undefined)?.trim();
const SHEET_TAB_NAME = (import.meta.env.VITE_GOOGLE_SHEETS_TAB_NAME as string | undefined)?.trim() || 'Stats';

const PENDING_SHEET_QUEUE_KEY = 'crc_pending_sheet_rows_queue';

interface PendingSheetRow {
  id: string;
  row: (string | number)[];
  timestamp: number;
}

function isConfigured(): boolean {
  return Boolean(WEBHOOK_URL && WEBHOOK_URL.startsWith('http'));
}

function getPendingRows(): PendingSheetRow[] {
  try {
    const raw = localStorage.getItem(PENDING_SHEET_QUEUE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function savePendingRows(rows: PendingSheetRow[]): void {
  try {
    localStorage.setItem(PENDING_SHEET_QUEUE_KEY, JSON.stringify(rows));
  } catch {
    // Ignore storage quota errors
  }
}

function queueRow(row: (string | number)[]): void {
  const rows = getPendingRows();
  rows.push({
    id: `sheetrow_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    row,
    timestamp: Date.now(),
  });
  savePendingRows(rows);
}

async function sendRow(row: (string | number)[]): Promise<void> {
  if (!WEBHOOK_URL) return;

  const payload: GoogleSheetRowPayload = {
    row,
    sheetName: SHEET_TAB_NAME,
  };
  if (SHEET_SECRET) payload.secret = SHEET_SECRET;

  // Sent as text/plain (not application/json) on purpose: Apps Script Web
  // Apps don't respond to CORS preflight (OPTIONS) requests, so keeping this
  // a "simple request" avoids the browser sending one. Apps Script still
  // reads the JSON body fine via e.postData.contents.
  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw new Error(`Google Sheets webhook HTTP ${res.status}`);
  }

  let data: { success?: boolean; error?: string } = {};
  try {
    data = await res.json();
  } catch {
    // Some Apps Script deployments return plain text; treat 200 as success.
    return;
  }
  if (data && data.success === false) {
    throw new Error(data.error || 'Google Sheets webhook reported failure');
  }
}

/** Flushes any rows that failed to send earlier (e.g. while offline). */
export async function flushPendingSheetRows(): Promise<number> {
  if (!isConfigured()) return 0;
  const rows = getPendingRows();
  if (rows.length === 0) return 0;

  const remaining: PendingSheetRow[] = [];
  let flushed = 0;

  for (const item of rows) {
    try {
      await sendRow(item.row);
      flushed++;
    } catch {
      remaining.push(item);
    }
  }

  savePendingRows(remaining);
  return flushed;
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    flushPendingSheetRows().catch(() => {});
  });
}

/**
 * Builds a single Google Sheet row (matching GOOGLE_SHEET_HEADERS order) from
 * a submitted vehicle's extracted stats.
 */
export function buildGoogleSheetRow(
  stats: ExtractedVehicleStats,
  sessionDateLabel: string,
  sessionService: string
): (string | number)[] {
  return [
    stats.submittedAt || new Date().toISOString(),
    stats.repName !== '—' ? stats.repName : '',
    sessionDateLabel,
    sessionService || 'Service',
    stats.type,
    stats.licensePlate !== '—' ? stats.licensePlate : '',
    stats.name,
    stats.presentListStr,
    stats.ftvListStr,
    stats.presentCount,
    stats.fareCollected,
    stats.absentCount > 0 ? -(stats.absentCount * 40) : 0,
    stats.cancellationListStr,
    stats.sponsoredListStr,
    stats.generalNotes,
  ];
}

/**
 * Pushes one submitted vehicle's stats to the Google Sheet. Never throws —
 * on failure (offline, misconfigured, Apps Script error) the row is queued
 * locally and retried automatically once connectivity returns, exactly like
 * the app's existing offline-submission queue.
 */
export async function syncVehicleStatsToGoogleSheet(
  stats: ExtractedVehicleStats,
  sessionDateLabel: string,
  sessionService: string
): Promise<{ synced: boolean; queued: boolean }> {
  if (!isConfigured()) {
    // Not set up yet — silently no-op so the app works fine without it.
    return { synced: false, queued: false };
  }

  const row = buildGoogleSheetRow(stats, sessionDateLabel, sessionService);

  try {
    await sendRow(row);
    // Opportunistically flush any older backlog now that we know we're online.
    flushPendingSheetRows().catch(() => {});
    return { synced: true, queued: false };
  } catch (err) {
    console.warn('[GoogleSheetsSync] Row queued for retry (send failed):', err);
    queueRow(row);
    return { synced: false, queued: true };
  }
}

export function isGoogleSheetsSyncConfigured(): boolean {
  return isConfigured();
}
