import test from 'node:test';
import assert from 'node:assert/strict';
import type { Manifest, Vehicle, Passenger } from './types';
import {
  generateSimpleTaxiRepsList,
  generateAllSundayTaxiRepsSimpleList,
  loadSundayManifests,
  SUNDAY_SERVICES_ORDER,
} from './whatsappManifest';

test('generateSimpleTaxiRepsList formats taxi reps and strictly excludes buses', () => {
  const riders: Passenger[] = [
    {
      id: 'p1',
      fullName: 'Sipho Dlamini',
      structure: 'S1',
      phone: '0821234567',
      stop: '56 Jorissen',
      assignedTo: 'v1',
      present: true,
      cancellationFeeOwed: false,
    },
    {
      id: 'p2',
      fullName: 'Thabo Mokoena',
      structure: 'S3',
      phone: '0839876543',
      stop: 'Apex',
      assignedTo: 'v2',
      present: true,
      cancellationFeeOwed: false,
    },
  ];

  const vehicles: Vehicle[] = [
    {
      id: 'v1',
      name: 'Taxi 1',
      type: 'Taxi',
      riders: ['p1'],
      repName: 'Sipho Dlamini',
    },
    {
      id: 'v2',
      name: 'Taxi 2',
      type: 'Taxi',
      riders: ['p2'],
      repName: 'Thabo Mokoena',
    },
    {
      id: 'v3',
      name: 'Bus 1',
      type: 'Bus',
      riders: [],
      repName: 'Bus Rep',
    },
  ];

  const manifest: Manifest = {
    date: '2026-08-23_AM_Serving',
    signups: riders,
    vehicles,
  };

  const simpleList = generateSimpleTaxiRepsList(manifest);
  assert.ok(simpleList.includes('Taxi 1: Sipho Dlamini (S1) - 0821234567'));
  assert.ok(simpleList.includes('Taxi 2: Thabo Mokoena (S3) - 0839876543'));
  assert.ok(!simpleList.includes('Bus 1'), 'Buses must be strictly excluded from taxi rep exports');
});

test('generateAllSundayTaxiRepsSimpleList formats all 4 Sunday services in exact order', () => {
  const amServingRider: Passenger = {
    id: 'p1',
    fullName: 'Sipho Serving',
    structure: 'S1',
    phone: '0821111111',
    stop: '56 Jorissen',
    assignedTo: 't1',
    present: true,
    cancellationFeeOwed: false,
  };
  const amServingManifest: Manifest = {
    date: '2026-08-23_AM_Serving',
    signups: [amServingRider],
    vehicles: [
      { id: 't1', name: 'Taxi 1', type: 'Taxi', riders: ['p1'], repName: 'Sipho Serving' },
    ],
  };

  const amNormalRider: Passenger = {
    id: 'p2',
    fullName: 'Lerato Normal',
    structure: 'S2',
    phone: '0822222222',
    stop: 'Gate 7',
    assignedTo: 't2',
    present: true,
    cancellationFeeOwed: false,
  };
  const amNormalManifest: Manifest = {
    date: '2026-08-23_AM_Normal',
    signups: [amNormalRider],
    vehicles: [
      { id: 't2', name: 'Taxi 1', type: 'Taxi', riders: ['p2'], repName: 'Lerato Normal' },
    ],
  };

  const pmServingRider: Passenger = {
    id: 'p3',
    fullName: 'Kagiso Evening',
    structure: 'S5',
    phone: '0823333333',
    stop: 'EOH',
    assignedTo: 't3',
    present: true,
    cancellationFeeOwed: false,
  };
  const pmServingManifest: Manifest = {
    date: '2026-08-23_PM_Serving',
    signups: [pmServingRider],
    vehicles: [
      { id: 't3', name: 'Taxi 1', type: 'Taxi', riders: ['p3'], repName: 'Kagiso Evening' },
    ],
  };

  // PM Normal has no taxis allocated
  const pmNormalManifest: Manifest = {
    date: '2026-08-23_PM_Normal',
    signups: [],
    vehicles: [],
  };

  const entries = [
    { service: 'AM_Serving', label: 'AM Serving', manifest: amServingManifest },
    { service: 'AM_Normal', label: 'AM Normal', manifest: amNormalManifest },
    { service: 'PM_Serving', label: 'PM Serving', manifest: pmServingManifest },
    { service: 'PM_Normal', label: 'PM Normal', manifest: pmNormalManifest },
  ];

  assert.strictEqual(SUNDAY_SERVICES_ORDER.length, 4);
  const output = generateAllSundayTaxiRepsSimpleList(entries);

  // Check section headers
  assert.ok(output.includes('AM SERVING TAXIS'));
  assert.ok(output.includes('AM NORMAL TAXIS'));
  assert.ok(output.includes('PM SERVING TAXIS'));
  assert.ok(output.includes('PM NORMAL TAXIS'));

  // Check order of appearance
  const amServingIdx = output.indexOf('AM SERVING TAXIS');
  const amNormalIdx = output.indexOf('AM NORMAL TAXIS');
  const pmServingIdx = output.indexOf('PM SERVING TAXIS');
  const pmNormalIdx = output.indexOf('PM NORMAL TAXIS');

  assert.ok(amServingIdx < amNormalIdx, 'AM Serving must appear before AM Normal');
  assert.ok(amNormalIdx < pmServingIdx, 'AM Normal must appear before PM Serving');
  assert.ok(pmServingIdx < pmNormalIdx, 'PM Serving must appear before PM Normal');

  // Check contents
  assert.ok(output.includes('Taxi 1: Sipho Serving (S1) - 0821111111'));
  assert.ok(output.includes('Taxi 1: Lerato Normal (S2) - 0822222222'));
  assert.ok(output.includes('Taxi 1: Kagiso Evening (S5) - 0823333333'));
  assert.ok(output.includes('No taxis allocated'));
});

test('loadSundayManifests prioritizes current in-memory manifest for active service', async () => {
  const currentManifest: Manifest = {
    date: '2026-08-23_AM_Serving',
    signups: [
      {
        id: 'p_test',
        fullName: 'Live Rep',
        structure: 'S9',
        phone: '0829998888',
        stop: 'Braam',
        assignedTo: 'v_live',
        present: true,
        cancellationFeeOwed: false,
      },
    ],
    vehicles: [
      { id: 'v_live', name: 'Taxi 1', type: 'Taxi', riders: ['p_test'], repName: 'Live Rep' },
    ],
  };

  const results = await loadSundayManifests('2026-08-23', currentManifest);
  assert.strictEqual(results.length, 4);

  const amServing = results.find((r) => r.service === 'AM_Serving');
  assert.ok(amServing?.manifest, 'AM_Serving should have a manifest');
  assert.strictEqual(amServing?.manifest?.signups[0].fullName, 'Live Rep');
});
