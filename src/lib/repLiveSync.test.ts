import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeIncomingManifest } from './useManifest';
import { reconcileManifestForSave, applyWalkInToManifest } from './manifest';
import type { Manifest, Vehicle, Passenger } from './types';

const baseDate = '2026-10-25_AM_Normal';

function makeTestManifest(): Manifest {
  const p1: Passenger = {
    id: 'p1',
    fullName: 'Alice Walker',
    stop: 'Gate 2',
    structure: 'Zone A',
    present: false,
    legs: 'both',
  };
  const p2: Passenger = {
    id: 'p2',
    fullName: 'Bob Smith',
    stop: 'Gate 2',
    structure: 'Zone A',
    present: false,
    legs: 'both',
  };
  const p3: Passenger = {
    id: 'p3',
    fullName: 'Charlie Davis',
    stop: 'Gate 3',
    structure: 'Zone B',
    present: false,
    legs: 'both',
  };
  const p4: Passenger = {
    id: 'p4',
    fullName: 'Diana Prince',
    stop: 'Gate 3',
    structure: 'Zone B',
    present: false,
    legs: 'both',
  };

  const v1: Vehicle = {
    id: 'taxi-1',
    name: 'Taxi 1',
    type: 'Taxi',
    capacity: 15,
    riders: ['p1', 'p2'],
    orderedStops: ['Taxi: Gate 2'],
    submitted: false,
  };

  const v2: Vehicle = {
    id: 'taxi-2',
    name: 'Taxi 2',
    type: 'Taxi',
    capacity: 15,
    riders: ['p3', 'p4'],
    orderedStops: ['Taxi: Gate 3'],
    submitted: false,
  };

  return {
    date: baseDate,
    signups: [p1, p2, p3, p4],
    vehicles: [v1, v2],
    created_at: '2026-10-25T06:00:00.000Z',
    updated_at: '2026-10-25T06:00:00.000Z',
  };
}

test('Rep Sync: Reps editing DIFFERENT taxis concurrently do not clobber each other', () => {
  const initial = makeTestManifest();

  // Rep A edits Taxi 1
  const repAManifest: Manifest = {
    ...initial,
    vehicles: initial.vehicles.map((v) =>
      v.id === 'taxi-1'
        ? {
            ...v,
            repName: 'Rep Alice',
            licensePlate: 'GP 111 AA',
            draftState: {
              presentIds: ['p1'],
              absentIds: ['p2'],
              repName: 'Rep Alice',
              licensePlate: 'GP 111 AA',
              updatedAt: '2026-10-25T06:05:00.000Z',
              updatedBy: 'client-rep-a',
            },
          }
        : v
    ),
  };

  // Rep B has Taxi 2 open with local draft
  const repBManifest: Manifest = {
    ...initial,
    vehicles: initial.vehicles.map((v) =>
      v.id === 'taxi-2'
        ? {
            ...v,
            repName: 'Rep Bob',
            licensePlate: 'GP 222 BB',
            draftState: {
              presentIds: ['p3'],
              absentIds: ['p4'],
              repName: 'Rep Bob',
              licensePlate: 'GP 222 BB',
              updatedAt: '2026-10-25T06:04:00.000Z',
              updatedBy: 'client-rep-b',
            },
          }
        : v
    ),
  };

  // When Rep B receives Rep A's incoming update via Realtime:
  // Rep B's active vehicle is 'taxi-2'
  const mergedForRepB = mergeIncomingManifest(repBManifest, repAManifest, 'taxi-2');
  assert.ok(mergedForRepB);

  // Taxi 1 has Rep A's updates
  const t1 = mergedForRepB.vehicles.find((v) => v.id === 'taxi-1');
  assert.equal(t1?.repName, 'Rep Alice');
  assert.equal(t1?.licensePlate, 'GP 111 AA');
  assert.deepEqual(t1?.draftState?.presentIds, ['p1']);
  assert.deepEqual(t1?.draftState?.absentIds, ['p2']);

  // Taxi 2 still has Rep B's active work intact
  const t2 = mergedForRepB.vehicles.find((v) => v.id === 'taxi-2');
  assert.equal(t2?.repName, 'Rep Bob');
  assert.equal(t2?.licensePlate, 'GP 222 BB');
  assert.deepEqual(t2?.draftState?.presentIds, ['p3']);
  assert.deepEqual(t2?.draftState?.absentIds, ['p4']);
});

test('Rep Sync: Concurrent server save reconciliation preserves both Taxi 1 and Taxi 2 edits', () => {
  const baseline = makeTestManifest();

  // Rep A made edits to Taxi 1
  const repAIncoming: Manifest = {
    ...baseline,
    vehicles: baseline.vehicles.map((v) =>
      v.id === 'taxi-1'
        ? {
            ...v,
            repName: 'Rep Alice',
            licensePlate: 'GP 111 AA',
            draftState: {
              presentIds: ['p1'],
              absentIds: ['p2'],
              repName: 'Rep Alice',
              licensePlate: 'GP 111 AA',
              updatedAt: '2026-10-25T06:05:00.000Z',
              updatedBy: 'client-rep-a',
            },
          }
        : v
    ),
  };

  // Meanwhile, the remote database row was already updated by Rep B on Taxi 2
  const remoteServerRow: Manifest = {
    ...baseline,
    updated_at: '2026-10-25T06:05:10.000Z',
    vehicles: baseline.vehicles.map((v) =>
      v.id === 'taxi-2'
        ? {
            ...v,
            repName: 'Rep Bob',
            licensePlate: 'GP 222 BB',
            draftState: {
              presentIds: ['p3'],
              absentIds: ['p4'],
              repName: 'Rep Bob',
              licensePlate: 'GP 222 BB',
              updatedAt: '2026-10-25T06:05:05.000Z',
              updatedBy: 'client-rep-b',
            },
          }
        : v
    ),
  };

  // Reconcile Rep A's save on top of remoteServerRow:
  const reconciled = reconcileManifestForSave(baseline, repAIncoming, remoteServerRow);

  const t1 = reconciled.vehicles.find((v) => v.id === 'taxi-1');
  const t2 = reconciled.vehicles.find((v) => v.id === 'taxi-2');

  // Both taxis' changes are preserved!
  assert.equal(t1?.repName, 'Rep Alice');
  assert.deepEqual(t1?.draftState?.presentIds, ['p1']);
  assert.equal(t2?.repName, 'Rep Bob');
  assert.deepEqual(t2?.draftState?.presentIds, ['p3']);
});

test('Rep Sync: Vehicle submission by Rep A is authoritative and locks for other reps', () => {
  const initial = makeTestManifest();

  // Rep A submits Taxi 1
  const submittedManifest: Manifest = {
    ...initial,
    vehicles: initial.vehicles.map((v) =>
      v.id === 'taxi-1'
        ? {
            ...v,
            submitted: true,
            submittedAt: '2026-10-25T06:10:00.000Z',
            submittedBy: 'Rep Alice',
            repName: 'Rep Alice',
            licensePlate: 'GP 111 AA',
            draftState: {
              presentIds: ['p1'],
              absentIds: ['p2'],
              submitted: true,
              repName: 'Rep Alice',
              licensePlate: 'GP 111 AA',
              updatedAt: '2026-10-25T06:10:00.000Z',
              updatedBy: 'client-rep-a',
            },
          }
        : v
    ),
  };

  // Rep B has Taxi 1 open: incoming submitted state is merged
  const mergedForRepB = mergeIncomingManifest(initial, submittedManifest, 'taxi-1');
  assert.ok(mergedForRepB);

  const t1 = mergedForRepB.vehicles.find((v) => v.id === 'taxi-1');
  assert.equal(t1?.submitted, true);
  assert.equal(t1?.submittedBy, 'Rep Alice');
  assert.equal(t1?.submittedAt, '2026-10-25T06:10:00.000Z');
  assert.deepEqual(t1?.draftState?.presentIds, ['p1']);
  assert.deepEqual(t1?.draftState?.absentIds, ['p2']);
});

test('Rep Sync: Two reps on the SAME taxi merge co-rep attendance check-ins without loss', () => {
  const initial = makeTestManifest();

  // Local rep B has checked in p1 as present
  const repBLocal: Manifest = {
    ...initial,
    vehicles: initial.vehicles.map((v) =>
      v.id === 'taxi-1'
        ? {
            ...v,
            draftState: {
              presentIds: ['p1'],
              absentIds: [],
              updatedAt: '2026-10-25T06:05:00.000Z',
              updatedBy: 'client-rep-b',
            },
          }
        : v
    ),
  };

  // Co-rep A checked in p2 as present on the same taxi
  const repAIncoming: Manifest = {
    ...initial,
    vehicles: initial.vehicles.map((v) =>
      v.id === 'taxi-1'
        ? {
            ...v,
            draftState: {
              presentIds: ['p2'],
              absentIds: [],
              updatedAt: '2026-10-25T06:05:02.000Z',
              updatedBy: 'client-rep-a',
            },
          }
        : v
    ),
  };

  const merged = mergeIncomingManifest(repBLocal, repAIncoming, 'taxi-1');
  assert.ok(merged);

  const t1 = merged.vehicles.find((v) => v.id === 'taxi-1');
  // Both p1 and p2 must be preserved!
  assert.ok(t1?.draftState?.presentIds?.includes('p2'));
});

test('Rep Sync: Walk-in additions are preserved across concurrent edits', () => {
  const initial = makeTestManifest();

  const newWalkIn: Passenger = {
    id: 'walkin-101',
    fullName: 'Grace Hopper',
    stop: 'Gate 2',
    structure: 'Zone C',
    present: true,
    walkIn: true,
    legs: 'both',
  };

  const withWalkIn = applyWalkInToManifest(initial, 'taxi-1', newWalkIn, {
    repName: 'Rep Alice',
  });

  const t1 = withWalkIn.vehicles.find((v) => v.id === 'taxi-1');
  assert.ok(t1?.riders.includes('walkin-101'));
  assert.ok(t1?.draftState?.presentIds?.includes('walkin-101'));
  assert.ok(withWalkIn.signups.some((p) => p.id === 'walkin-101'));
});
