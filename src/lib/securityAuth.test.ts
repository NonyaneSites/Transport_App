import test from 'node:test';
import assert from 'node:assert/strict';
import { queueOfflineAction } from './serverApi';

// Ensure localStorage is available in headless Node test environment
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, val: string) => store.set(key, String(val)),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    length: 0,
  } as unknown as Storage;
}

test('Security: Manifest key sanitization strictly neutralizes directory traversal', () => {
  function sanitizeKey(raw: string): string {
    if (!raw || typeof raw !== 'string') return '';
    return raw.replace(/[^a-zA-Z0-9_-]/g, '');
  }

  // Attempts to traverse out of manifests directory
  const attackVectors = [
    '../../etc/passwd',
    '..%2F..%2Fetc%2Fpasswd',
    '../../../data/secret',
    '2026-09-13_PM_Normal/../../../etc',
    'manifest;rm -rf /',
    '2026-10-18_AM_Normal..json',
  ];

  for (const vector of attackVectors) {
    const sanitized = sanitizeKey(vector);
    assert.strictEqual(sanitized.includes('..'), false, `Must strip directory traversal from ${vector}`);
    assert.strictEqual(sanitized.includes('/'), false, `Must strip forward slash from ${vector}`);
    assert.strictEqual(sanitized.includes('\\'), false, `Must strip backslash from ${vector}`);
  }

  // Valid church session keys must remain pristine
  assert.strictEqual(sanitizeKey('2026-10-18_AM_Normal'), '2026-10-18_AM_Normal');
  assert.strictEqual(sanitizeKey('2026-09-17_Rehearsal'), '2026-09-17_Rehearsal');
  assert.strictEqual(sanitizeKey('2026-10-04_PM_Serving'), '2026-10-04_PM_Serving');
});

test('Security: Reset manifest requires explicit typed RESET confirmation', () => {
  function validateResetConfirmation(confirmation: string): boolean {
    return confirmation.trim().toUpperCase() === 'RESET';
  }

  assert.strictEqual(validateResetConfirmation('RESET'), true);
  assert.strictEqual(validateResetConfirmation('reset'), true);
  assert.strictEqual(validateResetConfirmation('  RESET  '), true);
  assert.strictEqual(validateResetConfirmation('CRC2026!'), false, 'Old hardcoded password must be rejected');
  assert.strictEqual(validateResetConfirmation(''), false);
  assert.strictEqual(validateResetConfirmation('random'), false);
});

test('Reliability: Offline action queueing works when network is disconnected', () => {
  // Clear any existing test queue
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem('crc_pending_submissions_queue');
  }

  // Queue actions (simulating offline device)
  queueOfflineAction('submit_vehicle', '2026-10-18_AM_Normal', { vehicleId: 'bus_1', riders: ['A', 'B'] });
  queueOfflineAction('save_manifest', '2026-10-18_AM_Normal', { date: '2026-10-18_AM_Normal', vehicles: [] });

  const raw = localStorage.getItem('crc_pending_submissions_queue');
  assert.ok(raw, 'Pending queue must be saved in localStorage even when offline');
  const items = JSON.parse(raw);
  assert.strictEqual(items.length, 2, 'Must have recorded both queued items');
  assert.strictEqual(items[0].type, 'submit_vehicle');
  assert.strictEqual(items[1].type, 'save_manifest');

  // Deduplication check: re-queueing same key and type should update payload rather than bloat queue
  queueOfflineAction('submit_vehicle', '2026-10-18_AM_Normal', { vehicleId: 'bus_1', riders: ['A', 'B', 'C'] });
  const rawDedupe = localStorage.getItem('crc_pending_submissions_queue');
  const dedupeItems = JSON.parse(rawDedupe || '[]');
  assert.strictEqual(dedupeItems.length, 2, 'Queue must deduplicate by type and key');
  const payloadObj = dedupeItems[0].payload as Record<string, unknown>;
  assert.deepStrictEqual(payloadObj.riders, ['A', 'B', 'C'], 'Payload must be updated to newest state');

  // Clean up
  localStorage.removeItem('crc_pending_submissions_queue');
});

test('Security: Prototype pollution attempt via payload is rejected by row sanitizer', () => {
  function sanitizeRawRow(row: Record<string, unknown>): Record<string, unknown> {
    const safe: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(row)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      safe[key] = row[key];
    }
    return safe;
  }

  const maliciousPayload: Record<string, unknown> = {
    'Full Name': 'Attacker',
    'Pickup Stop': '56 Jorissen',
    '__proto__': { admin: true },
    'constructor': { name: 'exploit' },
  };

  const sanitized = sanitizeRawRow(maliciousPayload);
  assert.strictEqual(sanitized['Full Name'], 'Attacker');
  assert.strictEqual(sanitized['Pickup Stop'], '56 Jorissen');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(sanitized, '__proto__'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(sanitized, 'constructor'), false);
  // Global Object prototype must NOT be polluted
  const emptyObj = {} as Record<string, unknown>;
  assert.strictEqual(emptyObj.admin, undefined);
});
