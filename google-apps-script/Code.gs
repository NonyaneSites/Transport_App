/**
 * Transport App -> Google Sheets auto-sync webhook.
 *
 * What this does:
 * Every time a rep submits a vehicle in the Transport App, the app sends
 * one row of data here, and this script appends it to the "Stats" tab of
 * this spreadsheet — the exact same 15 columns as the app's existing
 * "Download Transport Stats" Excel export.
 *
 * ONE-TIME SETUP
 * 1. Open the Google Sheet (Transport_Operations.xlsx equivalent, the live
 *    Google Sheet version of it).
 * 2. Extensions -> Apps Script.
 * 3. Delete anything in Code.gs and paste this whole file in.
 * 4. (Optional but recommended) Set a shared secret below, e.g.
 *    const SHEET_SECRET = "some-long-random-string";
 *    and put the same value in the app's VITE_GOOGLE_SHEETS_SECRET env var.
 * 5. Click Deploy -> New deployment -> select type "Web app".
 *      - Execute as: Me
 *      - Who has access: Anyone
 *    (This does NOT make your spreadsheet data public — it only allows
 *    this specific script to receive POST requests. Only people who know
 *    the deployment URL, and the secret if you set one, can add rows.)
 * 6. Click Deploy, authorize the permissions it asks for, then copy the
 *    "Web app URL" it gives you.
 * 7. Paste that URL into the app's VITE_GOOGLE_SHEETS_WEBHOOK_URL
 *    environment variable and redeploy/restart the app.
 * 8. Submit a test vehicle in the app and confirm a new row appears here.
 *
 * If you ever need to update this script, choose Deploy -> Manage
 * deployments -> Edit (pencil icon) -> New version, so the same URL keeps
 * working (a brand new deployment gets a brand new URL).
 */

// Set this to a long random string to require the app to prove it's allowed
// to write here. Leave as '' to accept any request (simpler, less secure).
const SHEET_SECRET = '';

// Name of the tab these rows get appended to.
const DEFAULT_SHEET_NAME = 'Stats';

// Must match GOOGLE_SHEET_HEADERS in src/lib/googleSheetsSync.ts exactly,
// in the same order, since the app sends rows as plain arrays.
const EXPECTED_HEADERS = [
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
];

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonResponse({ success: false, error: 'No request body received' });
    }

    const body = JSON.parse(e.postData.contents);

    if (SHEET_SECRET && body.secret !== SHEET_SECRET) {
      return jsonResponse({ success: false, error: 'Invalid or missing secret' });
    }

    if (!Array.isArray(body.row)) {
      return jsonResponse({ success: false, error: '"row" must be an array' });
    }

    const sheetName = body.sheetName || DEFAULT_SHEET_NAME;
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName(sheetName);

    if (!sheet) {
      // Create the tab with headers if it doesn't exist yet.
      sheet = ss.insertSheet(sheetName);
      sheet.appendRow(EXPECTED_HEADERS);
    }

    // Convert the Timestamp column (index 0) from an ISO string into a real
    // Date object so it displays/sorts correctly in Sheets, same as a Google
    // Form submission would.
    const row = body.row.slice();
    if (row.length > 0 && typeof row[0] === 'string') {
      const parsed = new Date(row[0]);
      if (!isNaN(parsed.getTime())) {
        row[0] = parsed;
      }
    }

    sheet.appendRow(row);

    return jsonResponse({ success: true });
  } catch (err) {
    return jsonResponse({ success: false, error: String(err && err.message ? err.message : err) });
  }
}

// Lets you open the deployment URL directly in a browser to sanity-check
// that it's live (GET requests don't append rows, only POST does).
function doGet() {
  return jsonResponse({ success: true, message: 'Transport App Google Sheets webhook is live. Use POST to add rows.' });
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
