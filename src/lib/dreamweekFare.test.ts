import { test } from 'node:test';
import assert from 'node:assert';
import { isDreamWeekDate, getFareForDate, DREAMWEEK_FARE, CANCELLATION_FEE } from './types.js';
import { parseDebtAmount } from './ledger.js';

test('DreamWeek pricing: Weekdays are R45, Sundays are R40', () => {
  assert.strictEqual(DREAMWEEK_FARE, 45);
  assert.strictEqual(CANCELLATION_FEE, 40);
  // Tuesday 22 September 2026
  assert.strictEqual(isDreamWeekDate('2026-09-22'), true, 'Tuesday should be DreamWeek weekday');
  assert.strictEqual(getFareForDate('2026-09-22'), 45, 'Tuesday fare must be R45');

  // Wednesday 23 September 2026
  assert.strictEqual(isDreamWeekDate('2026-09-23'), true, 'Wednesday should be DreamWeek weekday');
  assert.strictEqual(getFareForDate('2026-09-23'), 45, 'Wednesday fare must be R45');

  // Thursday 24 September 2026
  assert.strictEqual(isDreamWeekDate('2026-09-24'), true, 'Thursday should be DreamWeek weekday');
  assert.strictEqual(getFareForDate('2026-09-24'), 45, 'Thursday fare must be R45');

  // Friday 25 September 2026
  assert.strictEqual(isDreamWeekDate('2026-09-25'), true, 'Friday should be DreamWeek weekday');
  assert.strictEqual(getFareForDate('2026-09-25'), 45, 'Friday fare must be R45');

  // Sunday 27 September 2026
  assert.strictEqual(isDreamWeekDate('2026-09-27'), false, 'Sunday is not a weekday conference day');
  assert.strictEqual(getFareForDate('2026-09-27'), 40, 'Sunday fare must be R40');

  // Sunday 20 September 2026
  assert.strictEqual(isDreamWeekDate('2026-09-20'), false, 'Sunday is not a weekday conference day');
  assert.strictEqual(getFareForDate('2026-09-20'), 40, 'Sunday fare must be R40');
});

test('parseDebtAmount falls back to date-specific fee', () => {
  assert.strictEqual(parseDebtAmount(undefined, '2026-09-23'), 45, 'Fallback for DreamWeek weekday is 45');
  assert.strictEqual(parseDebtAmount(undefined, '2026-09-27'), 40, 'Fallback for Sunday is 40');
  assert.strictEqual(parseDebtAmount('R45', '2026-09-23'), 45, 'Explicit R45 is preserved');
  assert.strictEqual(parseDebtAmount('40', '2026-09-23'), 40, 'Explicit R40 is preserved');
  assert.strictEqual(parseDebtAmount(0, '2026-09-23'), 0, 'Zero debt is preserved');
});
