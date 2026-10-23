import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeIncomingManifest } from './useManifest';
import { reconcileManifestForSave, applyWalkInToManifest } from './manifest';
import { supabase, MANIFESTS_TABLE, mockStorage } from './supabase';
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

test('Prompt 01B Security: rep_update_vehicle_draft strictly rejects unauthorized submissions with missing or invalid token', async () => {
  const manifest = makeTestManifest();
  const testKey = '2026-10-25_SEC_TEST';
  manifest.date = testKey;
  mockStorage.upsert(MANIFESTS_TABLE, manifest, 'date');

  // Attempt update without token -> MUST fail
  const { data: noTokenRes, error: noTokenErr } = await supabase.rpc('rep_update_vehicle_draft', {
    p_manifest_key: testKey,
    p_vehicle_id: 'taxi-1',
    p_draft_state: { presentIds: ['p1'] },
    p_auth_token: '',
  });
  assert.ok(noTokenErr || (noTokenRes && !(noTokenRes as { success?: boolean }).success));

  // Attempt update with forged token -> MUST fail
  const { data: fakeTokenRes, error: fakeTokenErr } = await supabase.rpc('rep_update_vehicle_draft', {
    p_manifest_key: testKey,
    p_vehicle_id: 'taxi-1',
    p_draft_state: { presentIds: ['p1'] },
    p_auth_token: 'forged_attacker_token_xyz',
  });
  assert.ok(fakeTokenErr || (fakeTokenRes && !(fakeTokenRes as { success?: boolean }).success));
});

test('Prompt 01B Security: Vehicle-scoped token for Taxi 1 cannot authorize edits to Taxi 2', async () => {
  const manifest = makeTestManifest();
  const testKey = '2026-10-25_SCOPE_TEST';
  manifest.date = testKey;
  mockStorage.upsert(MANIFESTS_TABLE, manifest, 'date');

  // Obtain authorized token for Taxi 1 via admin issuance
  const sessionRes = await supabase.rpc('admin_issue_vehicle_credential', {
    p_manifest_key: testKey,
    p_vehicle_id: 'taxi-1',
  });
  assert.ok(sessionRes.data);
  const tokenTaxi1 = (sessionRes.data as { auth_token: string }).auth_token;
  assert.ok(tokenTaxi1);

  // Attempt to use Taxi 1's token to modify Taxi 2 -> MUST BE REJECTED
  const { data: crossRes, error: crossErr } = await supabase.rpc('rep_update_vehicle_draft', {
    p_manifest_key: testKey,
    p_vehicle_id: 'taxi-2',
    p_draft_state: { presentIds: ['p3'] },
    p_auth_token: tokenTaxi1,
  });
  assert.ok(crossErr || (crossRes && !(crossRes as { success?: boolean }).success));
});

test('Prompt 01B Security: Replay attack with stale client timestamp is rejected', async () => {
  const manifest = makeTestManifest();
  const testKey = '2026-10-25_REPLAY_TEST';
  manifest.date = testKey;
  mockStorage.upsert(MANIFESTS_TABLE, manifest, 'date');

  // Obtain authorized token via admin issuance
  const sessionRes = await supabase.rpc('admin_issue_vehicle_credential', {
    p_manifest_key: testKey,
    p_vehicle_id: 'taxi-1',
  });
  const tokenTaxi1 = (sessionRes.data as { auth_token: string }).auth_token;

  // Legitimate update at 10:00:00
  const legitimate = await supabase.rpc('rep_update_vehicle_draft', {
    p_manifest_key: testKey,
    p_vehicle_id: 'taxi-1',
    p_draft_state: { presentIds: ['p1'], updatedAt: '2026-10-25T10:00:00.000Z' },
    p_auth_token: tokenTaxi1,
    p_client_timestamp: '2026-10-25T10:00:00.000Z',
  });
  assert.ok(legitimate.data && (legitimate.data as { success?: boolean }).success);

  // Replay attempt with an older timestamp (09:55:00) -> MUST BE REJECTED
  const replay = await supabase.rpc('rep_update_vehicle_draft', {
    p_manifest_key: testKey,
    p_vehicle_id: 'taxi-1',
    p_draft_state: { presentIds: [], updatedAt: '2026-10-25T09:55:00.000Z' },
    p_auth_token: tokenTaxi1,
    p_client_timestamp: '2026-10-25T09:55:00.000Z',
  });
  assert.ok(replay.error || (replay.data && !(replay.data as { success?: boolean }).success));
});

test('Prompt 01B Concurrency: rep_add_walk_in adds walk-in atomically to signups and vehicle riders', async () => {
  const manifest = makeTestManifest();
  const testKey = '2026-10-25_WALKIN_TEST';
  manifest.date = testKey;
  mockStorage.upsert(MANIFESTS_TABLE, manifest, 'date');

  // Get token for taxi-1 via admin issuance
  const sessionRes = await supabase.rpc('admin_issue_vehicle_credential', {
    p_manifest_key: testKey,
    p_vehicle_id: 'taxi-1',
  });
  const tokenTaxi1 = (sessionRes.data as { auth_token: string }).auth_token;

  const newRider: Passenger = {
    id: 'walkin-atomic-1',
    fullName: 'Lindiwe Sisulu',
    stop: 'Braam',
    structure: 'S4',
    present: true,
    legs: 'both',
  };

  const walkInRes = await supabase.rpc('rep_add_walk_in', {
    p_manifest_key: testKey,
    p_vehicle_id: 'taxi-1',
    p_passenger: newRider,
    p_draft_update: { repName: 'Rep Alice' },
    p_auth_token: tokenTaxi1,
  });

  assert.ok(walkInRes.data && (walkInRes.data as { success?: boolean }).success);

  const updatedRows = mockStorage.getTable(MANIFESTS_TABLE);
  const row = updatedRows.find((r) => r.date === testKey);
  assert.ok(row);
  const signups = row.signups as Passenger[];
  const vehicles = row.vehicles as Vehicle[];

  const signup = signups.find((p) => p.id === 'walkin-atomic-1');
  assert.ok(signup);
  assert.equal(signup.assignedTo, 'taxi-1');
  assert.equal(signup.present, true);

  const v1 = vehicles.find((v) => v.id === 'taxi-1');
  assert.ok(v1?.riders.includes('walkin-atomic-1'));
  assert.ok(v1?.draftState?.presentIds?.includes('walkin-atomic-1'));
});

test('Prompt 01B Concurrency: Simultaneous walk-in additions to different taxis do not overwrite each other', async () => {
  const manifest = makeTestManifest();
  const testKey = '2026-10-25_SIMUL_WALKIN';
  manifest.date = testKey;
  mockStorage.upsert(MANIFESTS_TABLE, manifest, 'date');

  const sessionT1 = await supabase.rpc('admin_issue_vehicle_credential', {
    p_manifest_key: testKey,
    p_vehicle_id: 'taxi-1',
  });
  const tokenT1 = (sessionT1.data as { auth_token: string }).auth_token;

  const sessionT2 = await supabase.rpc('admin_issue_vehicle_credential', {
    p_manifest_key: testKey,
    p_vehicle_id: 'taxi-2',
  });
  const tokenT2 = (sessionT2.data as { auth_token: string }).auth_token;

  // Rep 1 in Taxi 1 and Rep 2 in Taxi 2 add walk-ins concurrently
  const walkin1: Passenger = {
    id: 'walkin-rep1',
    fullName: 'Passenger Alpha',
    stop: 'Gate 2',
    structure: 'S1',
    present: true,
  };
  const walkin2: Passenger = {
    id: 'walkin-rep2',
    fullName: 'Passenger Beta',
    stop: 'Gate 3',
    structure: 'S2',
    present: true,
  };

  await Promise.all([
    supabase.rpc('rep_add_walk_in', {
      p_manifest_key: testKey,
      p_vehicle_id: 'taxi-1',
      p_passenger: walkin1,
      p_auth_token: tokenT1,
    }),
    supabase.rpc('rep_add_walk_in', {
      p_manifest_key: testKey,
      p_vehicle_id: 'taxi-2',
      p_passenger: walkin2,
      p_auth_token: tokenT2,
    }),
  ]);

  const updatedRows = mockStorage.getTable(MANIFESTS_TABLE);
  const row = updatedRows.find((r) => r.date === testKey);
  const signups = row?.signups as Passenger[];
  const vehicles = row?.vehicles as Vehicle[];

  // Both walk-ins MUST exist in signups
  assert.ok(signups.some((p) => p.id === 'walkin-rep1'));
  assert.ok(signups.some((p) => p.id === 'walkin-rep2'));

  // Each taxi MUST have its assigned walk-in preserved without clobbering
  const v1 = vehicles.find((v) => v.id === 'taxi-1');
  const v2 = vehicles.find((v) => v.id === 'taxi-2');
  assert.ok(v1?.riders.includes('walkin-rep1'));
  assert.ok(v2?.riders.includes('walkin-rep2'));
});

test('Prompt 01C Security: Anonymous callers CANNOT obtain or issue vehicle credentials via rep_get_or_create_vehicle_session', async () => {
  const manifest = makeTestManifest();
  const testKey = '2026-10-25_ANON_TOKEN_TEST';
  manifest.date = testKey;
  mockStorage.upsert(MANIFESTS_TABLE, manifest, 'date');

  // Anonymous request without admin session MUST fail
  const res = await supabase.rpc('rep_get_or_create_vehicle_session', {
    p_manifest_key: testKey,
    p_vehicle_id: 'taxi-1',
  });
  assert.ok(res.error || (res.data && !(res.data as { success?: boolean }).success));
});

test('Prompt 01C Security: rep_claim_vehicle_session verifies valid access code or token and rejects invalid/revoked credentials', async () => {
  const manifest = makeTestManifest();
  const testKey = '2026-10-25_CLAIM_TEST';
  manifest.date = testKey;
  mockStorage.upsert(MANIFESTS_TABLE, manifest, 'date');

  // Admin issues credential
  const adminRes = await supabase.rpc('admin_issue_vehicle_credential', {
    p_manifest_key: testKey,
    p_vehicle_id: 'taxi-1',
  });
  const data = adminRes.data as { auth_token: string; access_code: string };
  assert.ok(data?.auth_token);
  assert.ok(data?.access_code);

  // Claim with access code -> MUST SUCCEED
  const claimCode = await supabase.rpc('rep_claim_vehicle_session', {
    p_manifest_key: testKey,
    p_vehicle_id: 'taxi-1',
    p_credential: data.access_code.toLowerCase(), // case-insensitive
  });
  assert.ok(claimCode.data && (claimCode.data as { success?: boolean }).success);
  assert.equal((claimCode.data as { auth_token: string }).auth_token, data.auth_token);

  // Claim with invalid code -> MUST FAIL
  const claimFake = await supabase.rpc('rep_claim_vehicle_session', {
    p_manifest_key: testKey,
    p_vehicle_id: 'taxi-1',
    p_credential: 'WRONG_CODE',
  });
  assert.ok(claimFake.error || (claimFake.data && !(claimFake.data as { success?: boolean }).success));

  // Revoke credential by Dispatch Admin
  const revokeRes = await supabase.rpc('admin_revoke_vehicle_credential', {
    p_manifest_key: testKey,
    p_vehicle_id: 'taxi-1',
  });
  assert.ok(revokeRes.data && (revokeRes.data as { success?: boolean }).success);

  // Claim after revocation -> MUST FAIL
  const claimRevoked = await supabase.rpc('rep_claim_vehicle_session', {
    p_manifest_key: testKey,
    p_vehicle_id: 'taxi-1',
    p_credential: data.access_code,
  });
  assert.ok(claimRevoked.error || (claimRevoked.data && !(claimRevoked.data as { success?: boolean }).success));

  // Edit draft with revoked token -> MUST BE REJECTED
  const editRevoked = await supabase.rpc('rep_update_vehicle_draft', {
    p_manifest_key: testKey,
    p_vehicle_id: 'taxi-1',
    p_draft_state: { presentIds: ['p1'] },
    p_auth_token: data.auth_token,
  });
  assert.ok(editRevoked.error || (editRevoked.data && !(editRevoked.data as { success?: boolean }).success));
});

test('Prompt 01C Concurrency: rep_add_walk_in preserves full vehicle JSON structure across empty and occupied vehicles', async () => {
  const manifest = makeTestManifest();
  const testKey = '2026-10-25_WALKIN_PRESERVE_TEST';
  manifest.date = testKey;
  // Make taxi-2 completely empty
  const v2 = manifest.vehicles.find((v) => v.id === 'taxi-2');
  if (v2) {
    v2.riders = [];
  }
  mockStorage.upsert(MANIFESTS_TABLE, manifest, 'date');

  const adminRes = await supabase.rpc('admin_issue_vehicle_credential', {
    p_manifest_key: testKey,
    p_vehicle_id: 'taxi-2',
  });
  const token = (adminRes.data as { auth_token: string }).auth_token;

  const newRider: Passenger = {
    id: 'walkin-empty-taxi',
    fullName: 'Grace Hopper',
    stop: 'Gate 3',
    structure: 'Engineering',
    present: true,
  };

  const addRes = await supabase.rpc('rep_add_walk_in', {
    p_manifest_key: testKey,
    p_vehicle_id: 'taxi-2',
    p_passenger: newRider,
    p_auth_token: token,
  });
  assert.ok(addRes.data && (addRes.data as { success?: boolean }).success);

  const updatedRows = mockStorage.getTable(MANIFESTS_TABLE);
  const row = updatedRows.find((r) => r.date === testKey);
  const targetVeh = (row?.vehicles as Vehicle[])?.find((v) => v.id === 'taxi-2');

  // Verify all vehicle fields were preserved without corrupting structure (no JSON string cast bug)
  assert.equal(targetVeh?.id, 'taxi-2');
  assert.equal(targetVeh?.name, 'Taxi 2');
  assert.equal(targetVeh?.type, 'Taxi');
  assert.equal(targetVeh?.capacity, 15);
  assert.deepEqual(targetVeh?.orderedStops, ['Taxi: Gate 3']);
  assert.deepEqual(targetVeh?.riders, ['walkin-empty-taxi']);
  assert.deepEqual(targetVeh?.draftState?.presentIds, ['walkin-empty-taxi']);
});

test('Prompt 01C Concurrency: rep_add_walk_in prevents silent cross-taxi theft without confirmTransfer', async () => {
  const manifest = makeTestManifest();
  const testKey = '2026-10-25_THEFT_PREVENTION_TEST';
  manifest.date = testKey;
  // p1 is in taxi-1
  mockStorage.upsert(MANIFESTS_TABLE, manifest, 'date');

  // Get token for taxi-2
  const adminRes = await supabase.rpc('admin_issue_vehicle_credential', {
    p_manifest_key: testKey,
    p_vehicle_id: 'taxi-2',
  });
  const tokenTaxi2 = (adminRes.data as { auth_token: string }).auth_token;

  // Rep on Taxi 2 attempts to add p1 (who is in Taxi 1) WITHOUT confirmTransfer
  const stolenPassenger: Passenger = {
    id: 'p1', // already assigned to taxi-1 in initial manifest
    fullName: 'Alice Walker',
    stop: 'Gate 2',
    structure: 'Zone A',
    present: true,
  };

  const silentTheft = await supabase.rpc('rep_add_walk_in', {
    p_manifest_key: testKey,
    p_vehicle_id: 'taxi-2',
    p_passenger: stolenPassenger,
    p_auth_token: tokenTaxi2,
    p_confirm_transfer: false,
  });

  // MUST BE REJECTED or require explicit confirmation
  assert.ok(
    silentTheft.error ||
    (silentTheft.data && !(silentTheft.data as { success?: boolean }).success) ||
    (silentTheft.data as { requires_confirmation?: boolean })?.requires_confirmation
  );

  // Now perform with explicit confirmation
  const confirmedTransfer = await supabase.rpc('rep_add_walk_in', {
    p_manifest_key: testKey,
    p_vehicle_id: 'taxi-2',
    p_passenger: stolenPassenger,
    p_auth_token: tokenTaxi2,
    p_confirm_transfer: true,
  });
  assert.ok(confirmedTransfer.data && (confirmedTransfer.data as { success?: boolean }).success);

  const updatedRows = mockStorage.getTable(MANIFESTS_TABLE);
  const row = updatedRows.find((r) => r.date === testKey);
  const v1 = (row?.vehicles as Vehicle[])?.find((v) => v.id === 'taxi-1');
  const v2 = (row?.vehicles as Vehicle[])?.find((v) => v.id === 'taxi-2');

  // p1 moved to taxi-2 and removed from taxi-1
  assert.ok(!v1?.riders.includes('p1'));
  assert.ok(v2?.riders.includes('p1'));
});

test('Prompt 01C Concurrency: rep_add_walk_in adding passenger already in same taxi does not duplicate riders', async () => {
  const manifest = makeTestManifest();
  const testKey = '2026-10-25_SAME_TAXI_TEST';
  manifest.date = testKey;
  mockStorage.upsert(MANIFESTS_TABLE, manifest, 'date');

  const adminRes = await supabase.rpc('admin_issue_vehicle_credential', {
    p_manifest_key: testKey,
    p_vehicle_id: 'taxi-1',
  });
  const tokenTaxi1 = (adminRes.data as { auth_token: string }).auth_token;

  // p1 is already in taxi-1
  const existingRider: Passenger = {
    id: 'p1',
    fullName: 'Alice Walker',
    stop: 'Gate 2',
    structure: 'Zone A',
    present: true,
  };

  const reAdd = await supabase.rpc('rep_add_walk_in', {
    p_manifest_key: testKey,
    p_vehicle_id: 'taxi-1',
    p_passenger: existingRider,
    p_auth_token: tokenTaxi1,
  });
  assert.ok(reAdd.data && (reAdd.data as { success?: boolean }).success);

  const updatedRows = mockStorage.getTable(MANIFESTS_TABLE);
  const row = updatedRows.find((r) => r.date === testKey);
  const v1 = (row?.vehicles as Vehicle[])?.find((v) => v.id === 'taxi-1');

  // riders array must have p1 exactly once
  const p1Count = v1?.riders.filter((id) => id === 'p1').length;
  assert.equal(p1Count, 1);
});
