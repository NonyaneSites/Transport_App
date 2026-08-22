import {
  listLedgerEntries,
  aggregateLedgerEntries,
  BANK_DETAILS,
  type LedgerEntry,
} from './ledger';
import { shortDate } from './dates';

// Keys stored in localStorage
const GOOGLE_ACCESS_TOKEN_KEY = 'crc_gsuite_access_token';
const GOOGLE_EXPIRES_AT_KEY = 'crc_gsuite_token_expires_at';
const GOOGLE_SPREADSHEET_ID_KEY = 'crc_cancellation_spreadsheet_id';
const GOOGLE_SPREADSHEET_URL_KEY = 'crc_cancellation_spreadsheet_url';
const GOOGLE_CLIENT_ID_KEY = 'crc_gsuite_client_id';

// Default project client ID or environment variable
const DEFAULT_CLIENT_ID =
  (import.meta as unknown as { env: Record<string, string> }).env?.VITE_GOOGLE_CLIENT_ID ||
  '504215512188-app.apps.googleusercontent.com';

const SCOPES = 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file';

export interface GoogleSheetsState {
  isConnected: boolean;
  accessToken: string | null;
  spreadsheetId: string | null;
  spreadsheetUrl: string | null;
  lastSyncedAt: string | null;
  syncing: boolean;
  error: string | null;
}

export function getStoredAccessToken(): string | null {
  const token = localStorage.getItem(GOOGLE_ACCESS_TOKEN_KEY);
  const expiresAt = localStorage.getItem(GOOGLE_EXPIRES_AT_KEY);
  if (!token || !expiresAt) return null;
  if (Date.now() > Number(expiresAt)) {
    localStorage.removeItem(GOOGLE_ACCESS_TOKEN_KEY);
    localStorage.removeItem(GOOGLE_EXPIRES_AT_KEY);
    return null;
  }
  return token;
}

export function setStoredAccessToken(token: string, expiresInSeconds: number): void {
  const expiresAt = Date.now() + (expiresInSeconds - 60) * 1000;
  localStorage.setItem(GOOGLE_ACCESS_TOKEN_KEY, token);
  localStorage.setItem(GOOGLE_EXPIRES_AT_KEY, String(expiresAt));
}

export function getStoredSpreadsheet(): { id: string | null; url: string | null } {
  return {
    id: localStorage.getItem(GOOGLE_SPREADSHEET_ID_KEY),
    url: localStorage.getItem(GOOGLE_SPREADSHEET_URL_KEY),
  };
}

export function setStoredSpreadsheet(id: string, url: string): void {
  localStorage.setItem(GOOGLE_SPREADSHEET_ID_KEY, id);
  localStorage.setItem(GOOGLE_SPREADSHEET_URL_KEY, url);
}

export function clearGoogleSession(): void {
  localStorage.removeItem(GOOGLE_ACCESS_TOKEN_KEY);
  localStorage.removeItem(GOOGLE_EXPIRES_AT_KEY);
}

export function getGoogleClientId(): string {
  return localStorage.getItem(GOOGLE_CLIENT_ID_KEY) || DEFAULT_CLIENT_ID;
}

export function setGoogleClientId(clientId: string): void {
  localStorage.setItem(GOOGLE_CLIENT_ID_KEY, clientId);
}

interface GoogleAccountsOAuth2 {
  initTokenClient: (config: {
    client_id: string;
    scope: string;
    callback: (response: { access_token?: string; expires_in?: number; error?: string }) => void;
  }) => {
    requestAccessToken: (options?: { prompt?: string }) => void;
  };
}

interface GoogleGlobal {
  accounts?: {
    oauth2?: GoogleAccountsOAuth2;
  };
}

/**
 * Initiates the Google OAuth token flow using Google Identity Services (GIS).
 */
export function requestGoogleToken(clientId?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const google = (window as unknown as { google?: GoogleGlobal }).google;
    if (!google?.accounts?.oauth2) {
      reject(new Error('Google Identity Services script is still loading. Please try again in a moment.'));
      return;
    }

    const activeClientId = clientId || getGoogleClientId();

    try {
      const client = google.accounts.oauth2.initTokenClient({
        client_id: activeClientId,
        scope: SCOPES,
        callback: (tokenResponse: { access_token?: string; expires_in?: number; error?: string }) => {
          if (tokenResponse.error) {
            reject(new Error(`Google Authentication failed: ${tokenResponse.error}`));
            return;
          }
          if (tokenResponse.access_token) {
            setStoredAccessToken(tokenResponse.access_token, tokenResponse.expires_in || 3600);
            resolve(tokenResponse.access_token);
          } else {
            reject(new Error('No access token received from Google.'));
          }
        },
      });

      client.requestAccessToken({ prompt: '' });
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * Creates a brand-new Google Sheet formatted for the SZ Cancellation Ledger.
 */
export async function createCancellationSpreadsheet(
  token: string,
  title: string = `CRC Transport - Cancellation Ledger ${new Date().getFullYear()}`
): Promise<{ id: string; url: string }> {
  const response = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      properties: {
        title,
      },
      sheets: [
        {
          properties: {
            title: 'SZ Cancellation List',
            gridProperties: {
              frozenRowCount: 7,
            },
          },
        },
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `Failed to create Google Sheet (${response.status})`);
  }

  const data = await response.json();
  const id = data.spreadsheetId;
  const url = data.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${id}/edit`;

  setStoredSpreadsheet(id, url);
  return { id, url };
}

/**
 * Syncs the current active cancellation ledger directly to Google Sheets.
 * Automatically creates a new sheet if one hasn't been created yet.
 * Only writes submitted entries — absentees from re-opened vehicles are
 * automatically absent from this sync until submitted again.
 */
export async function syncLedgerToGoogleSheet(
  providedToken?: string,
  providedSpreadsheetId?: string
): Promise<{
  success: boolean;
  spreadsheetId: string;
  spreadsheetUrl: string;
  rowCount: number;
  totalDebt: number;
}> {
  const token = providedToken || getStoredAccessToken();
  if (!token) {
    throw new Error('Google account not connected. Please connect Google Sheets.');
  }

  let { id: spreadsheetId, url: spreadsheetUrl } = getStoredSpreadsheet();
  if (providedSpreadsheetId) {
    spreadsheetId = providedSpreadsheetId;
    spreadsheetUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
  }

  // Create new sheet if none exists
  if (!spreadsheetId) {
    const created = await createCancellationSpreadsheet(token);
    spreadsheetId = created.id;
    spreadsheetUrl = created.url;
  }

  // Fetch current live ledger entries from Supabase (only contains submitted lists)
  const entries: LedgerEntry[] = await listLedgerEntries();
  const groups = aggregateLedgerEntries(entries);
  const totalDebt = groups.reduce((sum, g) => sum + g.totalDebt, 0);

  const nowStr = new Date().toLocaleString('en-ZA', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  // Prepare Official Format Values (AOA)
  const values: (string | number)[][] = [
    ['CRC Johannesburg — 2026 SZ Cancellation List'],
    [`Live Synchronization: Active & Confirmed Vehicle Attendance Submissions Only (Updated: ${nowStr})`],
    [''],
    ['Policy & Payment Information'],
    ['1. Outstanding cancellation fees (R40/person) must be settled within 3 weeks of the missed service.'],
    ['2. Each structure is collectively liable for the unpaid cancellation fees of its members.'],
    [`3. Banking Details: ${BANK_DETAILS.bank} | Acc: ${BANK_DETAILS.accountNumber} | Branch: ${BANK_DETAILS.branchCode} | Name: ${BANK_DETAILS.accountName}`],
    ['4. Proof of Payment (POP) Upload Link: https://forms.gle/HDvmuZywzNitWFpU6'],
    [''],
    [`Total Outstanding Cancellation Debt: R${totalDebt}`, '', '', `Total Entries: ${entries.length}`],
    [''],
    ['Structure', 'Rep / Submitter', 'Cancellation Date', 'Passenger Name', 'Service', 'Vehicle', 'Amount Owing (ZAR)', 'Status'],
  ];

  for (const group of groups) {
    for (const row of group.rows) {
      values.push([
        row.structure,
        row.repName || '—',
        shortDate(row.latestDate),
        row.name,
        row.service,
        row.vehicleName || '—',
        `R${row.amount}`,
        'Owing (Pending Payment)',
      ]);
    }
  }

  // 1. Clear existing values in sheet to eliminate removed/withdrawn entries completely
  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/'SZ Cancellation List'!A1:Z5000:clear`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    }
  );

  // 2. Write new full live payload
  const updateRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/'SZ Cancellation List'!A1?valueInputOption=USER_ENTERED`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        values,
      }),
    }
  );

  if (!updateRes.ok) {
    const err = await updateRes.json().catch(() => ({}));
    throw new Error(err.error?.message || `Failed to update Google Sheet values (${updateRes.status})`);
  }

  // 3. Format header styling in Google Sheets
  try {
    await formatCancellationSheet(spreadsheetId, token);
  } catch (fmtErr) {
    console.warn('Google Sheet formatting note:', fmtErr);
  }

  localStorage.setItem('crc_cancellation_last_synced', new Date().toISOString());

  return {
    success: true,
    spreadsheetId,
    spreadsheetUrl: spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
    rowCount: entries.length,
    totalDebt,
  };
}

/**
 * Formats column headers, column widths, and title block in the Google Sheet.
 */
async function formatCancellationSheet(spreadsheetId: string, token: string): Promise<void> {
  const requests = [
    // Column widths
    {
      updateDimensionProperties: {
        range: {
          sheetId: 0,
          dimension: 'COLUMNS',
          startIndex: 0,
          endIndex: 8,
        },
        properties: {
          pixelSize: 170,
        },
        fields: 'pixelSize',
      },
    },
    // Widen specific columns
    {
      updateDimensionProperties: {
        range: { sheetId: 0, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 },
        properties: { pixelSize: 140 },
        fields: 'pixelSize',
      },
    },
    {
      updateDimensionProperties: {
        range: { sheetId: 0, dimension: 'COLUMNS', startIndex: 3, endIndex: 4 },
        properties: { pixelSize: 220 },
        fields: 'pixelSize',
      },
    },
    // Header row (Row 12: index 11) background and bold text
    {
      repeatCell: {
        range: {
          sheetId: 0,
          startRowIndex: 11,
          endRowIndex: 12,
          startColumnIndex: 0,
          endColumnIndex: 8,
        },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 0.6, green: 0.05, blue: 0.1 }, // Crimson
            textFormat: {
              bold: true,
              foregroundColor: { red: 1.0, green: 1.0, blue: 1.0 },
              fontSize: 10,
            },
            horizontalAlignment: 'CENTER',
          },
        },
        fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)',
      },
    },
    // Title row (Row 1: index 0)
    {
      repeatCell: {
        range: {
          sheetId: 0,
          startRowIndex: 0,
          endRowIndex: 1,
          startColumnIndex: 0,
          endColumnIndex: 8,
        },
        cell: {
          userEnteredFormat: {
            textFormat: {
              bold: true,
              fontSize: 14,
              foregroundColor: { red: 0.1, green: 0.1, blue: 0.1 },
            },
          },
        },
        fields: 'userEnteredFormat(textFormat)',
      },
    },
  ];

  await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ requests }),
  });
}

/**
 * Helper to safely trigger a background sync to Google Sheets whenever a rep
 * submits attendance or reopens a vehicle. If user is authenticated, it keeps
 * the Google Sheet in instant 100% sync.
 */
export async function autoSyncGoogleSheetsSilently(): Promise<{ synced: boolean; error?: string }> {
  const token = getStoredAccessToken();
  if (!token) return { synced: false, error: 'not_authenticated' };

  try {
    await syncLedgerToGoogleSheet(token);
    return { synced: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn('Auto-sync to Google Sheets notice:', msg);
    return { synced: false, error: msg };
  }
}
