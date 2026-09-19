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

test('parseWorkbook() accurately parses updated sheets format (CSV & XLSX)', () => {
  const csvData = [
    'Timestamp,Email,Service Date,Name,Surname,Phone Number,Area Stops2,Auckland Park Stops,Braamfontein Stops,Doornfontein Stops,CBD/Maboneng/Marshalltown,Fordsburg Stops,Milpark/ Richmond/ Cottesloe Stops,Parktown Stops,Westdene/ Melville Stops,Other stops,Which service are you attending?,Are you serving?,Are you a member or visitor,Homecell Leader\'s Name,Homecell Leader\'s Contact,Zone,Structure,Email Address',
    '8/19/2026 21:28:03,,23 August 2026,Moses,Mashilo,693084231,Braamfontein Stops,,Apex,,,,,,,,AM Service,No,"Yes, I am a member",Nelly,0821234567,SZ1,S1,thatomashilo789@gmail.com',
    '8/17/2026 9:38:52,tsiloane941@gmail.com,23 August 2026,Nelly,Tsiloane,718675364,Braamfontein Stops,,Apex,,,,,,,,AM Service,Yes,"Yes, I am a member",Option 1,,SZ1,S1,',
    '8/16/2026 21:40:43,,23 August 2026,Khensani,Mhlanga,812345678,Auckland Park Stops,APK McDonald\'s,,,,,,,,,AM Service,No,"No, it is my first time visiting",Lindiwe,0831234567,YZ,YA,khensani@gmail.com',
  ].join('\n');

  // Test 1: Direct CSV string parsing
  const csvRes = parseWorkbook(csvData, {
    selectedDate: '2026-08-23',
    selectedService: 'AM_Serving',
  });

  assert.strictEqual(csvRes.passengers.length, 3);

  // Moses Mashilo: check name, phone restoration with 0, stop, leader, memberType
  const moses = csvRes.passengers.find((p) => p.fullName === 'Moses Mashilo');
  assert.ok(moses, 'Moses Mashilo should be found');
  assert.strictEqual(moses.phone, '0693084231', '9-digit phone must have leading 0 restored');
  assert.strictEqual(moses.stop, 'Apex');
  assert.strictEqual(moses.homecellLeader, 'Nelly');
  assert.strictEqual(moses.memberType, 'M');
  assert.strictEqual(moses.userEmail, 'thatomashilo789@gmail.com');

  // Nelly Tsiloane: check serving status, leader filtered (Option 1 filtered out)
  const nelly = csvRes.passengers.find((p) => p.fullName === 'Nelly Tsiloane');
  assert.ok(nelly, 'Nelly Tsiloane should be found');
  assert.strictEqual(nelly.category, 'Serving');
  assert.strictEqual(nelly.phone, '0718675364');
  assert.strictEqual(nelly.homecellLeader, undefined, 'Option 1 should be treated as empty leader');

  // Khensani Mhlanga: FTV visitor
  const khensani = csvRes.passengers.find((p) => p.fullName === 'Khensani Mhlanga');
  assert.ok(khensani, 'Khensani Mhlanga should be found');
  assert.strictEqual(khensani.memberType, 'FTV');
  assert.strictEqual(khensani.homecellLeader, 'Lindiwe');

  // Test 2: XLSX workbook parsing with identical data
  const wb = XLSX.read(csvData, { type: 'string' });
  const xlsxBuf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  const xlsxRes = parseWorkbook(xlsxBuf, {
    selectedDate: '2026-08-23',
    selectedService: 'AM_Serving',
  });
  assert.strictEqual(xlsxRes.passengers.length, 3);
  const mosesXlsx = xlsxRes.passengers.find((p) => p.fullName === 'Moses Mashilo');
  assert.ok(mosesXlsx);
  assert.strictEqual(mosesXlsx.phone, '0693084231');
});

test('parseWorkbook() accurately parses PM version spreadsheet (CSV and XLSX)', () => {
  const pmCsv = [
    `Timestamp,Email,Service Date,Name,Surname,Cellphone,PM Service Type,Ministry,Are you a Member,Zone,SZ1 Structures,SZ2 Structures,YZ Structures,Do you need transport?,Area Stops,Braam Stops,Auckland Park Stops,CBD Stops,Parktown Stops,Midrand Stops,Soweto Stops,JHB North & West Stops,"Terms",Email Address,Homecell Leader's Name,Homecell Leader's Name,Homecell Leader's Name`,
    `8/19/2026 22:08:22,refentseh514gmail.com,23 August 2026,Refentse,Tlhabudugwane ,0676418606,Serving,Usher,"Yes, I am a member",Zone S1 - Ps Edson,S6,,,Yes,Braam Stops,56 Jorissen,,,,,,,I agree,refentseh514@gmail.com,,,`,
    `8/19/2026 20:16:44,Obarei09@gmail.com,23 August 2026,Onalerona ,Barei ,0684262985,Normal,,"Yes, I am a member",Zone S1 - Ps Edson,S21,,,Yes,JHB West & North Stops,,,,,,,Florida Lake,I agree,onaleronabareilesejane@gmail.com,,,`,
    `9/14/2026 16:31:15,,20 September 2026,Nthabiseng,Mosekidi,0766616397,Normal,,"Yes, I am a member",Zone S1 - Ps Edson,S1,,,Yes,CBD Stops,,,Focus 1,,,,,I agree,mosekidin@gmail.com,Tebatso,,`,
    `9/14/2026 19:10:11,,20 September 2026,Kgalalelo ,Seema,842493929,Normal,,"Yes, I am a member",Zone S2 - Kabelo,,S16,,Yes,Parktown Stops,,,,EOH,,,,I agree,klseema.07@gmail.com,,Matodzi ,`,
    `9/17/2026 21:08:31,,20 September 2026,Mhlengi,Mdluli,+27 0 71 061 7587,Normal,,I am still a visitor,Zone Y - Ps Edson,,,YZ,Yes,Braam Stops,56 Jorissen,,,,,,,I agree,mhlengimdluli23@gmail.com,,,Gao`
  ].join('\n');

  // Convert to XLSX buffer
  const wb = XLSX.read(pmCsv, { type: 'string' });
  const xlsxBuf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });

  // 1. PM_Serving on 23 August 2026
  const resServing = parseWorkbook(xlsxBuf, {
    selectedDate: '2026-08-23',
    selectedService: 'PM_Serving',
  });
  assert.strictEqual(resServing.passengers.length, 1);
  const refentse = resServing.passengers[0];
  assert.ok(refentse);
  assert.strictEqual(refentse!.fullName, 'Refentse Tlhabudugwane');
  assert.strictEqual(refentse!.category, 'Serving');
  assert.strictEqual(refentse!.ministry, 'Usher');
  assert.strictEqual(refentse!.stop, '56 Jorissen');
  assert.strictEqual(refentse!.structure, 'S6');
  assert.strictEqual(refentse!.memberType, 'M');

  // 2. PM_Normal on 23 August 2026
  const resNormal = parseWorkbook(xlsxBuf, {
    selectedDate: '2026-08-23',
    selectedService: 'PM_Normal',
  });
  assert.strictEqual(resNormal.passengers.length, 1);
  const onalerona = resNormal.passengers[0];
  assert.ok(onalerona);
  assert.strictEqual(onalerona!.fullName, 'Onalerona Barei');
  assert.strictEqual(onalerona!.stop, 'Florida Lake');
  assert.strictEqual(onalerona!.structure, 'S21');

  // 3. PM_Normal on 20 September 2026 — check multiple Homecell Leader columns
  const resSep = parseWorkbook(xlsxBuf, {
    selectedDate: '2026-09-20',
    selectedService: 'PM_Normal',
  });
  assert.strictEqual(resSep.passengers.length, 3);

  // Column 1 leader (Tebatso)
  const nthabiseng = resSep.passengers.find((p) => p.fullName === 'Nthabiseng Mosekidi');
  assert.ok(nthabiseng);
  assert.strictEqual(nthabiseng!.homecellLeader, 'Tebatso');
  assert.strictEqual(nthabiseng!.stop, 'Focus 1');
  assert.strictEqual(nthabiseng!.structure, 'S1');

  // Column 2 leader (Matodzi) with 9-digit phone restored to 10-digit
  const kgalalelo = resSep.passengers.find((p) => p.fullName === 'Kgalalelo Seema');
  assert.ok(kgalalelo);
  assert.strictEqual(kgalalelo!.homecellLeader, 'Matodzi');
  assert.strictEqual(kgalalelo!.phone, '0842493929');
  assert.strictEqual(kgalalelo!.stop, 'EOH');
  assert.strictEqual(kgalalelo!.structure, 'S16');

  // Column 3 leader (Gao) with visitor status
  const mhlengi = resSep.passengers.find((p) => p.fullName === 'Mhlengi Mdluli');
  assert.ok(mhlengi);
  assert.strictEqual(mhlengi!.homecellLeader, 'Gao');
  assert.strictEqual(mhlengi!.memberType, 'V');
  assert.strictEqual(mhlengi!.structure, 'YZ');

  // 4. AM selection on PM sheet should return 0 passengers
  const resAM = parseWorkbook(xlsxBuf, {
    selectedDate: '2026-08-23',
    selectedService: 'AM_Serving',
  });
  assert.strictEqual(resAM.passengers.length, 0);
});
