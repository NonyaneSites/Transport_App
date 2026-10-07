import { test } from 'node:test';
import assert from 'node:assert';
import {
  evaluateRehearsalTransportAnswer,
  parseRehearsalSheet,
  formatRehearsalWhatsAppManifest,
  normalizeRehearsalStop,
} from './rehearsal.js';
import type { Passenger, Vehicle } from './types.js';

test('Answer -> legs mapping for all 11 form answers', () => {
  // 1. "Yes (Going and Return with REHEARSAL taxi)" -> both (R70)
  const a1 = evaluateRehearsalTransportAnswer('Yes (Going and Return with REHEARSAL taxi)', 'Braam', '2026-09-17');
  assert.strictEqual(a1.status, 'included');
  assert.strictEqual(a1.legs, 'both');
  assert.strictEqual(a1.fare, 70);

  // 2. "Yes (Going and Return)" -> both (R70)
  const a2 = evaluateRehearsalTransportAnswer('Yes (Going and Return)', 'Braam', '2026-09-17');
  assert.strictEqual(a2.status, 'included');
  assert.strictEqual(a2.legs, 'both');
  assert.strictEqual(a2.fare, 70);

  // 3. "Yes (Going with REHEARSAL taxi ONLY)" -> going (R40)
  const a3 = evaluateRehearsalTransportAnswer('Yes (Going with REHEARSAL taxi ONLY)', 'Braam', '2026-09-17');
  assert.strictEqual(a3.status, 'included');
  assert.strictEqual(a3.legs, 'going');
  assert.strictEqual(a3.fare, 40);

  // 4. "Yes (Going only)" -> going (R40)
  const a4 = evaluateRehearsalTransportAnswer('Yes (Going only)', 'Braam', '2026-09-17');
  assert.strictEqual(a4.status, 'included');
  assert.strictEqual(a4.legs, 'going');
  assert.strictEqual(a4.fare, 40);

  // 5. "Yes (Returning with REHEARSAL taxi ONLY)" -> return (R40)
  const a5 = evaluateRehearsalTransportAnswer('Yes (Returning with REHEARSAL taxi ONLY)', 'Braam', '2026-09-17');
  assert.strictEqual(a5.status, 'included');
  assert.strictEqual(a5.legs, 'return');
  assert.strictEqual(a5.fare, 40);

  // 6. "Yes (Return Only)" -> return (R40)
  const a6 = evaluateRehearsalTransportAnswer('Yes (Return Only)', 'Braam', '2026-09-17');
  assert.strictEqual(a6.status, 'included');
  assert.strictEqual(a6.legs, 'return');
  assert.strictEqual(a6.fare, 40);

  // 7. "Yes (Going with INTERCESSION taxi, Returning with REHEARSAL taxi)" -> return (R40, note = "Intercession going")
  const a7 = evaluateRehearsalTransportAnswer('Yes (Going with INTERCESSION taxi, Returning with REHEARSAL taxi)', 'Braam', '2026-09-17');
  assert.strictEqual(a7.status, 'included');
  assert.strictEqual(a7.legs, 'return');
  assert.strictEqual(a7.fare, 40);
  assert.strictEqual(a7.note, 'Intercession going');

  // 8. "Yes (Going and Return with INTERCESSION taxi)" -> NOT on rehearsal manifest
  const a8 = evaluateRehearsalTransportAnswer('Yes (Going and Return with INTERCESSION taxi)', 'Braam', '2026-09-17');
  assert.strictEqual(a8.status, 'intercession_excluded');
  assert.strictEqual(a8.fare, 0);

  // 9. "Yes (Going with INTERCESSION taxi ONLY)" -> NOT on rehearsal manifest
  const a9 = evaluateRehearsalTransportAnswer('Yes (Going with INTERCESSION taxi ONLY)', 'Braam', '2026-09-17');
  assert.strictEqual(a9.status, 'intercession_excluded');
  assert.strictEqual(a9.fare, 0);

  // 10. "Yes (Returning with INTERCESSION taxi ONLY)" -> NOT on rehearsal manifest
  const a10 = evaluateRehearsalTransportAnswer('Yes (Returning with INTERCESSION taxi ONLY)', 'Braam', '2026-09-17');
  assert.strictEqual(a10.status, 'intercession_excluded');
  assert.strictEqual(a10.fare, 0);

  // 11. "No (Private transport)" and Stops = "Using private transport" -> excluded entirely
  const a11a = evaluateRehearsalTransportAnswer('No (Private transport)', 'Braam', '2026-09-17');
  assert.strictEqual(a11a.status, 'private_excluded');

  const a11b = evaluateRehearsalTransportAnswer('Yes (Going only)', 'Using private transport', '2026-09-17');
  assert.strictEqual(a11b.status, 'private_excluded');
});

test('Rehearsal fare calculation (40/40/70) vs DreamWeek rule override', () => {
  // Regular Thursday 17 Sep 2026: 40 going, 40 return, 70 both
  assert.strictEqual(evaluateRehearsalTransportAnswer('Yes (Going only)', 'Braam', '2026-09-17').fare, 40);
  assert.strictEqual(evaluateRehearsalTransportAnswer('Yes (Return only)', 'Braam', '2026-09-17').fare, 40);
  assert.strictEqual(evaluateRehearsalTransportAnswer('Yes (Going and Return)', 'Braam', '2026-09-17').fare, 70);

  // Thursday during DreamWeek (1 October 2026): DreamWeek rules win (R45 per trip)
  assert.strictEqual(evaluateRehearsalTransportAnswer('Yes (Going only)', 'Braam', '2026-10-01').fare, 45);
  assert.strictEqual(evaluateRehearsalTransportAnswer('Yes (Going and Return)', 'Braam', '2026-10-01').fare, 45);
});

test('Duplicate handling: latest submission by Timestamp wins', () => {
  const mockRows = [
    {
      Timestamp: '2026/09/16 10:00:00 AM',
      'Name + Surname': 'Thabo Ndwebi',
      Date: '17 September 2026',
      'Do you need Thursday Transport': 'Yes (Going only)',
      Stops: 'Braam',
    },
    {
      Timestamp: '2026/09/16 02:00:00 PM',
      'Name + Surname': 'Thabo Ndwebi',
      Date: '17 September 2026',
      'Do you need Thursday Transport': 'Yes (Going and Return with REHEARSAL taxi)',
      Stops: 'Braam',
    },
    {
      Timestamp: '2026/09/16 08:00:00 AM',
      'Name + Surname': 'Linelle Mulumba',
      Date: '17 September 2026',
      'Do you need Thursday Transport': 'Yes (Going and Return)',
      Stops: 'Braam',
    },
  ];

  const parsed = parseRehearsalSheet(mockRows, '2026-09-17');
  assert.strictEqual(parsed.summary.totalResponsesForDate, 3);
  assert.strictEqual(parsed.summary.duplicatesRemoved, 1);
  assert.strictEqual(parsed.included.length, 2);

  const thabo = parsed.included.find((p) => p.passenger.fullName === 'Thabo Ndwebi');
  assert.ok(thabo);
  // Latest submission was "Going and Return" (both, R70)
  assert.strictEqual(thabo.legs, 'both');
  assert.strictEqual(thabo.fare, 70);
});

test('Stop normalization merges variants (e.g. Gate 2 -> UJ Gate 2)', () => {
  assert.strictEqual(normalizeRehearsalStop('Gate 2').stop, 'UJ Gate 2');
  assert.strictEqual(normalizeRehearsalStop('uj gate 2').stop, 'UJ Gate 2');
  assert.strictEqual(normalizeRehearsalStop('Wits Gate 7').stop, 'Wits Gate 7');
  assert.strictEqual(normalizeRehearsalStop('gate 7').stop, 'Wits Gate 7');
  assert.strictEqual(normalizeRehearsalStop('Westdene Engine').stop, 'Westdene Engine');
  assert.strictEqual(normalizeRehearsalStop('westdene').stop, 'Westdene Engine');
  assert.strictEqual(normalizeRehearsalStop('Unknown Stop ABC').isUnknown, true);
});

test('WhatsApp output format using 17 Sep example', () => {
  const p1: Passenger = {
    id: 'p1',
    fullName: 'Linelle Mulumba',
    stop: 'Braam',
    structure: 'S1',
    present: false,
    cancellationFeeOwed: false,
    assignedTo: null,
    legs: 'both',
  };
  const p2: Passenger = {
    id: 'p2',
    fullName: 'Keitumetse Masilo',
    stop: 'Braam',
    structure: 'S1',
    present: false,
    cancellationFeeOwed: false,
    assignedTo: null,
    legs: 'return',
  };
  const p3: Passenger = {
    id: 'p3',
    fullName: 'Thato Ndwebi',
    stop: 'Braam',
    structure: 'S1',
    present: false,
    cancellationFeeOwed: false,
    assignedTo: null,
    legs: 'both',
  };
  const p4: Passenger = {
    id: 'p4',
    fullName: 'Murothodzi Ndwammbi',
    stop: 'Wits Gate 7',
    structure: 'S2',
    present: false,
    cancellationFeeOwed: false,
    assignedTo: null,
    legs: 'return',
  };
  const p5: Passenger = {
    id: 'p5',
    fullName: 'Liyema Lando',
    stop: 'Wits Gate 7',
    structure: 'S2',
    present: false,
    cancellationFeeOwed: false,
    assignedTo: null,
    legs: 'both',
  };
  const p6: Passenger = {
    id: 'p6',
    fullName: 'E JaV',
    stop: 'Maboneng',
    structure: 'S3',
    present: false,
    cancellationFeeOwed: false,
    assignedTo: null,
    legs: 'both',
  };

  const v1: Vehicle = {
    id: 'v1',
    name: 'Taxi 1',
    type: 'Taxi',
    riders: ['p1', 'p2', 'p3', 'p4', 'p5'],
    orderedStops: ['Braam', 'Wits Gate 7'],
    stopTimes: {
      Braam: '17:00',
      'Wits Gate 7': '17:10',
    },
  };

  const v2: Vehicle = {
    id: 'v2',
    name: 'Taxi 2',
    type: 'Taxi',
    riders: ['p6'],
    orderedStops: ['Maboneng'],
    stopTimes: {
      Maboneng: '16:55',
    },
  };

  const output = formatRehearsalWhatsAppManifest([v1, v2], [p1, p2, p3, p4, p5, p6]);

  const expected = `Rehearsal taxi
🚖 TAXI 1

*🛑Braam 17:00*
1.Keitumetse Masilo (Return)
2.Linelle Mulumba
3.Thato Ndwebi

*🛑Wits Gate 7 17:10*
1.Liyema Lando
2.Murothodzi Ndwammbi (Return)


🚖 TAXI 2

*🛑Maboneng 16:55*
1.E JaV`;

  assert.strictEqual(output.trim(), expected.trim());
});
