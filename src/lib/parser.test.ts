import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import {
  extractRowDate,
  isSignupSheet,
  isRowEmpty,
  trimTrailingEmptyRows,
  parseWorkbook,
  parseWorkbookAsync,
  NON_SIGNUP_SHEET_PATTERN,
} from './parser';

test('extractRowDate() parses unanchored date with trailing label', () => {
  // Requirement 3: Exactly "11 September 2026 - Night Vigil"
  const targetString = '11 September 2026 - Night Vigil';
  const result = extractRowDate(targetString);
  assert.strictEqual(result, '2026-09-11', 'Must parse "11 September 2026 - Night Vigil" to "2026-09-11"');
});

test('extractRowDate() parses varied date formats with leading or trailing labels', () => {
  assert.strictEqual(extractRowDate('Friday, 11 September 2026 - Night Vigil'), '2026-09-11');
  assert.strictEqual(extractRowDate('September 11, 2026 - Night Vigil'), '2026-09-11');
  assert.strictEqual(extractRowDate('September 11 2026 (Night Vigil)'), '2026-09-11');
  assert.strictEqual(extractRowDate('11th September 2026 - Night Vigil'), '2026-09-11');
  assert.strictEqual(extractRowDate('7 Sep 2025'), '2025-09-07');
  assert.strictEqual(extractRowDate('2026-09-11 - Night Vigil'), '2026-09-11');
  assert.strictEqual(extractRowDate('11/09/2026 - Night Vigil'), '2026-09-11');
});

test('extractRowDate() works with row object and headers', () => {
  const headers = ['Completion time', 'Name', 'Service Date', 'Area Stops'];
  const row = {
    'Completion time': '2026-09-01 10:00:00',
    Name: 'Test Passenger',
    'Service Date': '11 September 2026 - Night Vigil',
    'Area Stops': 'Braam stops',
  };
  const result = extractRowDate(row, headers);
  assert.strictEqual(result, '2026-09-11');
});

test('isSignupSheet() filters out computed tables, goal trackers, and sheets without identity columns', () => {
  // Requirement 1: Skip sheets matching /table|tracker|goal/i
  assert.match('PM Table', NON_SIGNUP_SHEET_PATTERN);
  assert.match('AM Table', NON_SIGNUP_SHEET_PATTERN);
  assert.match('SZ1 Goal tracker', NON_SIGNUP_SHEET_PATTERN);
  assert.match('SZ1 Goal Tracker', NON_SIGNUP_SHEET_PATTERN);

  assert.strictEqual(isSignupSheet('PM Table', ['Full Name', 'Stop']), false);
  assert.strictEqual(isSignupSheet('AM Table', ['Name', 'Surname']), false);
  assert.strictEqual(isSignupSheet('SZ1 Goal tracker', ['Name', 'Goal']), false);

  // Sheets without identity columns should be skipped even if name seems fine
  assert.strictEqual(isSignupSheet('Summary Data', ['Date', 'Attendance', 'Total Taxis']), false);
  assert.strictEqual(isSignupSheet('Route Overview', ['Stop Name', 'Bus Capacity', 'Driver']), false);

  // Valid signup sheets
  assert.strictEqual(isSignupSheet('PM RSVP', ['Full Name', 'Phone', 'Pickup Stop']), true);
  assert.strictEqual(isSignupSheet('AM RSVP (Serving)', ['Name', 'Surname', 'Service']), true);
  assert.strictEqual(isSignupSheet('Events RSVP', ['Passenger Name', 'Service Date', 'Stop']), true);
});

test('isRowEmpty() and trimTrailingEmptyRows() discard trailing blank rows', () => {
  // Requirement 2: Handling Excel formatting extending past data
  assert.strictEqual(isRowEmpty({ Name: '', Phone: '', Stop: '   ' }), true);
  assert.strictEqual(isRowEmpty({ Name: 'Kabelo', Phone: '' }), false);

  const sampleRows = [
    { Name: 'Thabo Khumalo', Stop: 'Saratoga' },
    { Name: 'Lerato Sithole', Stop: 'Junction' },
    { Name: '', Stop: '' },
    { Name: '   ', Stop: undefined as unknown as string },
    { Name: '', Stop: null as unknown as string },
  ];

  const trimmed = trimTrailingEmptyRows(sampleRows);
  assert.strictEqual(trimmed.length, 2, 'Trailing 3 empty rows must be trimmed away');
  assert.strictEqual(trimmed[0].Name, 'Thabo Khumalo');
  assert.strictEqual(trimmed[1].Name, 'Lerato Sithole');
});

test('parseWorkbook() end-to-end: skips summary sheets, trims padding, and respects unanchored date', () => {
  // Create an Excel workbook in memory with:
  // 1. "Events RSVP" (Real signups with "11 September 2026 - Night Vigil" + trailing blank rows)
  // 2. "PM Table" (Computed summary table)
  // 3. "SZ1 Goal tracker" (Dashboard sheet)
  const wb = XLSX.utils.book_new();

  // Sheet 1: Events RSVP with 2 real rows + 30 trailing empty rows
  const rsvpRows: Record<string, string>[] = [
    {
      'Full Name': 'Sipho Ndlovu',
      'Phone Number': '0821234567',
      'Service Date': '11 September 2026 - Night Vigil',
      'Area Stops': 'Braam stops',
      'Braam stops': '56 Jorissen',
      'Which service are you attending': 'PM Service',
      'Do you need transport': 'Yes',
    },
    {
      'Full Name': 'Nomsa Dlamini',
      'Phone Number': '0719876543',
      'Service Date': '18 September 2026',
      'Area Stops': 'Auckland park stops',
      'Auckland park stops': 'Gate 2',
      'Which service are you attending': 'PM Service',
      'Do you need transport': 'Yes',
    },
  ];

  // Add 30 blank trailing rows simulating Excel formatted range
  for (let i = 0; i < 30; i++) {
    rsvpRows.push({
      'Full Name': '',
      'Phone Number': '',
      'Service Date': '',
      'Area Stops': '',
      'Braam stops': '',
      'Which service are you attending': '',
      'Do you need transport': '',
    });
  }

  const rsvpSheet = XLSX.utils.json_to_sheet(rsvpRows);
  XLSX.utils.book_append_sheet(wb, rsvpSheet, 'Events RSVP');

  // Sheet 2: PM Table (dashboard sheet)
  const pmTableRows = [
    { 'Table Category': 'Braam Hub', 'Count': '45', 'Taxis Allocated': '3' },
    { 'Table Category': 'Parktown Hub', 'Count': '30', 'Taxis Allocated': '2' },
  ];
  const pmTableSheet = XLSX.utils.json_to_sheet(pmTableRows);
  XLSX.utils.book_append_sheet(wb, pmTableSheet, 'PM Table');

  // Sheet 3: SZ1 Goal tracker (goal tracking sheet)
  const goalRows = [
    { 'Structure': 'S1', 'Target': '20', 'Current': '18' },
    { 'Structure': 'S2', 'Target': '15', 'Current': '15' },
  ];
  const goalSheet = XLSX.utils.json_to_sheet(goalRows);
  XLSX.utils.book_append_sheet(wb, goalSheet, 'SZ1 Goal tracker');

  const wbBuf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });

  // Test with selectedDate = '2026-09-11'
  const resultMatching = parseWorkbook(wbBuf, {
    selectedDate: '2026-09-11',
    selectedService: 'PM_Normal',
  });

  // Verify skippedSheets captured the non-signup sheets
  assert.ok(resultMatching.skippedSheets.includes('PM Table'), 'Must skip PM Table');
  assert.ok(resultMatching.skippedSheets.includes('SZ1 Goal tracker'), 'Must skip SZ1 Goal tracker');
  assert.strictEqual(resultMatching.skippedSheets.length, 2);

  // Verify trailing blank rows were trimmed (only 2 real rows counted)
  assert.strictEqual(resultMatching.totalRows, 2, 'Total rows must be 2 after trimming 30 trailing empty rows');

  // Verify "11 September 2026 - Night Vigil" passenger was matched for 2026-09-11
  assert.strictEqual(resultMatching.passengers.length, 1);
  assert.strictEqual(resultMatching.passengers[0].fullName, 'Sipho Ndlovu');

  // Test with selectedDate = '2026-09-18'
  const resultOtherDate = parseWorkbook(wbBuf, {
    selectedDate: '2026-09-18',
    selectedService: 'PM_Normal',
  });
  assert.strictEqual(resultOtherDate.passengers.length, 1);
  assert.strictEqual(resultOtherDate.passengers[0].fullName, 'Nomsa Dlamini');

  // Test with a different date, e.g. '2026-09-25'
  // Crucial test: neither passenger should match!
  // (Previously, unparseable date caused "11 September 2026 - Night Vigil" to match ALL dates!)
  const resultUnmatchedDate = parseWorkbook(wbBuf, {
    selectedDate: '2026-09-25',
    selectedService: 'PM_Normal',
  });
  assert.strictEqual(resultUnmatchedDate.passengers.length, 0, 'No passengers should match 2026-09-25');
});

test('parseWorkbookAsync() yields progress and returns identical ParseResult', async () => {
  const wb = XLSX.utils.book_new();
  const rows = [
    {
      'Full Name': 'Tshepo Mokwena',
      'Phone Number': '0831112233',
      'Service Date': '11 September 2026 - Night Vigil',
      'Pickup Stop': '56 Jorissen',
      'Which service are you attending': 'PM Service',
      'Do you need transport': 'Yes',
    },
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'RSVP');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([{ Metric: 10 }]), 'AM Table');

  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  const progressEvents: string[] = [];

  const result = await parseWorkbookAsync(
    buf,
    { selectedDate: '2026-09-11', selectedService: 'PM_Normal' },
    (prog) => {
      progressEvents.push(`${prog.phase}:${prog.sheetName}`);
    }
  );

  assert.strictEqual(result.passengers.length, 1);
  assert.strictEqual(result.passengers[0].fullName, 'Tshepo Mokwena');
  assert.deepStrictEqual(result.skippedSheets, ['AM Table']);
  assert.ok(progressEvents.length >= 2, 'Must report progress events across phases');
});

test('AM Normal minimum threshold is 14: 13 auto-merges into AM Serving, 14 does not', () => {
  // Test case 1: 13 AM Normal signups (< 14) + 2 AM Serving signups
  // When parsing AM_Serving, all 15 should be included (13 Normal auto-merged because 13 < 14)
  const wb13 = XLSX.utils.book_new();
  const rows13: Record<string, string>[] = [
    {
      'Full Name': 'Server One',
      'Which service are you attending': 'AM Service',
      'AM Service Type': 'Serving',
      'Serving Ministry': 'Choir',
      'Do you need transport': 'Yes',
      'Pickup Stop': '56 Jorissen',
      'Service Date': '2026-09-13',
    },
    {
      'Full Name': 'Server Two',
      'Which service are you attending': 'AM Service',
      'AM Service Type': 'Serving',
      'Serving Ministry': 'Band',
      'Do you need transport': 'Yes',
      'Pickup Stop': '56 Jorissen',
      'Service Date': '2026-09-13',
    },
  ];
  for (let i = 1; i <= 13; i++) {
    rows13.push({
      'Full Name': `Normal Attendee ${i}`,
      'Which service are you attending': 'AM Service',
      'AM Service Type': 'Normal',
      'Do you need transport': 'Yes',
      'Pickup Stop': '56 Jorissen',
      'Service Date': '2026-09-13',
    });
  }
  XLSX.utils.book_append_sheet(wb13, XLSX.utils.json_to_sheet(rows13), 'AM Signups');
  const buf13 = XLSX.write(wb13, { type: 'array', bookType: 'xlsx' });

  const resServing13 = parseWorkbook(buf13, {
    selectedDate: '2026-09-13',
    selectedService: 'AM_Serving',
  });
  // Because normalCount (13) < 14, they auto-merge into AM Serving
  assert.strictEqual(resServing13.passengers.length, 15);
  assert.ok(resServing13.warnings.some((w) => w.includes('Auto-Included: 13 AM Normal signups merged into AM Serving (13 < 14 minimum for a taxi)')));

  // Test case 2: 14 AM Normal signups (>= 14) + 2 AM Serving signups
  // When parsing AM_Serving, the 14 Normal signups should NOT be auto-merged into AM Serving
  const wb14 = XLSX.utils.book_new();
  const rows14: Record<string, string>[] = [
    ...rows13,
    {
      'Full Name': 'Normal Attendee 14',
      'Which service are you attending': 'AM Service',
      'AM Service Type': 'Normal',
      'Do you need transport': 'Yes',
      'Pickup Stop': '56 Jorissen',
      'Service Date': '2026-09-13',
    },
  ];
  XLSX.utils.book_append_sheet(wb14, XLSX.utils.json_to_sheet(rows14), 'AM Signups');
  const buf14 = XLSX.write(wb14, { type: 'array', bookType: 'xlsx' });

  const resServing14 = parseWorkbook(buf14, {
    selectedDate: '2026-09-13',
    selectedService: 'AM_Serving',
  });
  // Normal signups have reached 14 (dedicated taxi threshold), so only the 2 servers are included in AM_Serving
  assert.strictEqual(resServing14.passengers.length, 2);
  assert.ok(resServing14.warnings.some((w) => w.includes('14 AM Normal signups detected. Available under "AM Service — Normal Only"')));

  // When parsing AM_Normal, all 14 are included
  const resNormal14 = parseWorkbook(buf14, {
    selectedDate: '2026-09-13',
    selectedService: 'AM_Normal',
  });
  assert.strictEqual(resNormal14.passengers.length, 14);
  assert.ok(resNormal14.warnings.some((w) => w.includes('✓ 14 AM Normal signups available')));
});
