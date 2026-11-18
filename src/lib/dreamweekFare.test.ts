import { test } from 'node:test';
import assert from 'node:assert';
import {
  isDreamWeekDate,
  isNov18Date,
  getFareForDate,
  getPassengerFare,
  DREAMWEEK_FARE,
  NOV_18_FARE,
  CANCELLATION_FEE,
} from './types.js';
import { parseDebtAmount } from './ledger.js';
import { extractVehicleStats } from './statsExport.js';
import type { Passenger, Vehicle } from './types.js';

test('DreamWeek pricing: Weekdays are R45 ONLY from 29 Sep to 2 Oct 2026, other days are R40', () => {
  assert.strictEqual(DREAMWEEK_FARE, 45);
  assert.strictEqual(CANCELLATION_FEE, 40);

  // Thursday 24 September 2026 must NOT be DreamWeek
  assert.strictEqual(isDreamWeekDate('2026-09-24'), false, '24 Sep 2026 Thursday is not in DreamWeek window');
  assert.strictEqual(getFareForDate('2026-09-24'), 40, '24 Sep 2026 fare must be R40');

  // Tuesday 22 September 2026
  assert.strictEqual(isDreamWeekDate('2026-09-22'), false, '22 Sep 2026 is before DreamWeek window');
  assert.strictEqual(getFareForDate('2026-09-22'), 40, '22 Sep 2026 fare must be R40');

  // DreamWeek window: 29 Sep to 2 Oct 2026
  // Tuesday 29 September 2026
  assert.strictEqual(isDreamWeekDate('2026-09-29'), true, 'Tuesday 29 Sep should be DreamWeek');
  assert.strictEqual(getFareForDate('2026-09-29'), 45, 'Tuesday 29 Sep fare must be R45');

  // Wednesday 30 September 2026
  assert.strictEqual(isDreamWeekDate('2026-09-30'), true, 'Wednesday 30 Sep should be DreamWeek');
  assert.strictEqual(getFareForDate('2026-09-30'), 45, 'Wednesday 30 Sep fare must be R45');

  // Thursday 1 October 2026
  assert.strictEqual(isDreamWeekDate('2026-10-01'), true, 'Thursday 1 Oct should be DreamWeek');
  assert.strictEqual(getFareForDate('2026-10-01'), 45, 'Thursday 1 Oct fare must be R45');

  // Friday 2 October 2026
  assert.strictEqual(isDreamWeekDate('2026-10-02'), true, 'Friday 2 Oct should be DreamWeek');
  assert.strictEqual(getFareForDate('2026-10-02'), 45, 'Friday 2 Oct fare must be R45');

  // Saturday 3 October 2026
  assert.strictEqual(isDreamWeekDate('2026-10-03'), false, 'Saturday 3 Oct is after DreamWeek');
  assert.strictEqual(getFareForDate('2026-10-03'), 40, 'Saturday 3 Oct fare must be R40');

  // Sunday 27 September 2026
  assert.strictEqual(isDreamWeekDate('2026-09-27'), false, 'Sunday is not a weekday conference day');
  assert.strictEqual(getFareForDate('2026-09-27'), 40, 'Sunday fare must be R40');

  // Sunday 20 September 2026
  assert.strictEqual(isDreamWeekDate('2026-09-20'), false, 'Sunday is not a weekday conference day');
  assert.strictEqual(getFareForDate('2026-09-20'), 40, 'Sunday fare must be R40');
});

test('18 November pricing: every person is R75 regardless of legs or service', () => {
  assert.strictEqual(NOV_18_FARE, 75);
  assert.strictEqual(isNov18Date('2026-11-18'), true);
  assert.strictEqual(isNov18Date('2026-11-18_AM_Normal'), true);
  assert.strictEqual(isNov18Date('2026-11-19'), false);

  assert.strictEqual(getFareForDate('2026-11-18'), 75);
  assert.strictEqual(getPassengerFare({ service: 'Rehearsal', legs: 'both' }, '2026-11-18'), 75);
  assert.strictEqual(getPassengerFare({ service: 'Rehearsal', legs: 'going' }, '2026-11-18'), 75);
  assert.strictEqual(getPassengerFare({ service: 'AM', legs: 'both' }, '2026-11-18'), 75);

  // Regular Rehearsal pricing outside 18 Nov remains R70 / R40
  assert.strictEqual(getPassengerFare({ service: 'Rehearsal', legs: 'both' }, '2026-11-12'), 70);
  assert.strictEqual(getPassengerFare({ service: 'Rehearsal', legs: 'going' }, '2026-11-12'), 40);
});

test('parseDebtAmount falls back to date-specific fee', () => {
  assert.strictEqual(parseDebtAmount(undefined, '2026-10-01'), 45, 'Fallback for DreamWeek date is 45');
  assert.strictEqual(parseDebtAmount(undefined, '2026-09-24'), 40, 'Fallback for regular Thursday is 40');
  assert.strictEqual(parseDebtAmount(undefined, '2026-09-27'), 40, 'Fallback for Sunday is 40');
  assert.strictEqual(parseDebtAmount(undefined, '2026-11-18'), 75, 'Fallback for 18 November is 75');
  assert.strictEqual(parseDebtAmount(undefined, '2026-11-18', 'Rehearsal', 'going'), 75, 'Fallback for 18 November Rehearsal is 75');
  assert.strictEqual(parseDebtAmount('R45', '2026-10-01'), 45, 'Explicit R45 is preserved');
  assert.strictEqual(parseDebtAmount('40', '2026-10-01'), 40, 'Explicit R40 is preserved');
  assert.strictEqual(parseDebtAmount(0, '2026-10-01'), 0, 'Zero debt is preserved');
});

test('extractVehicleStats computes R75 per paying rider on 18 November', () => {
  const riders: Passenger[] = [
    { id: 'p1', fullName: 'Alice', stop: 'Gate 2', structure: 'S1', present: true, sponsored: false, legs: 'both' },
    { id: 'p2', fullName: 'Bob', stop: 'Gate 2', structure: 'S1', present: true, sponsored: false, legs: 'going' },
    { id: 'p3', fullName: 'Charlie', stop: 'Gate 2', structure: 'S1', present: true, sponsored: true, legs: 'both' },
    { id: 'p4', fullName: 'Dana', stop: 'Gate 2', structure: 'S1', present: false, sponsored: false, legs: 'both' },
  ];
  const vehicle: Vehicle = {
    id: 'taxi-1',
    name: 'Taxi 1',
    type: 'Taxi',
    capacity: 15,
    riders: ['p1', 'p2', 'p3', 'p4'],
    orderedStops: ['Taxi: Gate 2'],
    submitted: true,
    draftState: {
      presentIds: ['p1', 'p2', 'p3'],
      absentIds: ['p4'],
      sponsoredIds: ['p3'],
      submitted: true,
    },
  };
  const lookup = new Map(riders.map((r) => [r.id, r]));
  const stats = extractVehicleStats(vehicle, (id) => lookup.get(id), '2026-11-18');
  assert.strictEqual(stats.presentCount, 3);
  assert.strictEqual(stats.sponsoredCount, 1);
  assert.strictEqual(stats.fareCollected, 150, 'Two paying riders x R75 = R150');
});

