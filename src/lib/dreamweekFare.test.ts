import { test } from 'node:test';
import assert from 'node:assert';
import { isDreamWeekDate, getFareForDate, DREAMWEEK_FARE, CANCELLATION_FEE } from './types.js';
import { parseDebtAmount } from './ledger.js';

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

test('parseDebtAmount falls back to date-specific fee', () => {
  assert.strictEqual(parseDebtAmount(undefined, '2026-10-01'), 45, 'Fallback for DreamWeek date is 45');
  assert.strictEqual(parseDebtAmount(undefined, '2026-09-24'), 40, 'Fallback for regular Thursday is 40');
  assert.strictEqual(parseDebtAmount(undefined, '2026-09-27'), 40, 'Fallback for Sunday is 40');
  assert.strictEqual(parseDebtAmount('R45', '2026-10-01'), 45, 'Explicit R45 is preserved');
  assert.strictEqual(parseDebtAmount('40', '2026-10-01'), 40, 'Explicit R40 is preserved');
  assert.strictEqual(parseDebtAmount(0, '2026-10-01'), 0, 'Zero debt is preserved');
});
