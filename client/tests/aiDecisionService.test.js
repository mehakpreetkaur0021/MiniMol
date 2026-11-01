import assert from 'node:assert/strict';
import test from 'node:test';
import { requestAiDecisions } from '../src/services/aiDecisionService.js';
import { buildTrafficSnapshot } from '../src/services/trafficSnapshotBuilder.js';
import { generateVehicles } from '../src/services/vehicleGenerator.js';
import { createSimulationState } from '../src/services/simulationEngine.js';
import { VEHICLE_STATUSES } from '../src/services/vehicleGenerator.js';

function simulationWithVehicles(changesById = {}, extraVehicles = []) {
  const simulation = createSimulationState(generateVehicles('snapshot-test'));
  return {
    ...simulation,
    vehicles: simulation.vehicles.map((vehicle) => ({ ...vehicle, ...changesById[vehicle.id] })).concat(extraVehicles),
  };
}

test('traffic snapshot builder includes every simulated vehicle and supplied eligibility', () => {
  const simulation = createSimulationState(generateVehicles('snapshot-test'));
  const snapshot = buildTrafficSnapshot({
    tickId: 'decision-0-1',
    scenarioId: 'traffic-scenario-0',
    simulation,
    eligibleVehicleIds: [],
  });

  assert.equal(snapshot.vehicles.length, 20);
  assert.equal(snapshot.tickId, 'decision-0-1');
  assert.equal(snapshot.intersection.occupancy.known, true);
  assert.deepEqual(snapshot.intersection.occupancy.occupiedZones, []);
  assert.equal(snapshot.intersection.occupancy.dataSource, 'simulation CROSSING vehicle states and route envelopes');
  assert.equal(snapshot.intersection.conflictInformation.available, true);
  assert.match(snapshot.intersection.conflictInformation.compatibilityNotes[0], /No vehicles are currently crossing/);
  assert.deepEqual(snapshot.eligibleVehicleIds, []);
  assert.equal(snapshot.vehicles.every((vehicle) => 'atStopLine' in vehicle), true);
});

test('traffic snapshot derives active occupancy and route conflicts from live CROSSING vehicles', () => {
  const simulation = simulationWithVehicles({
    V001: { incomingDirection: 'NORTH', route: 'STRAIGHT', status: VEHICLE_STATUSES.WAITING, atStopLine: true },
    V011: { incomingDirection: 'EAST', route: 'STRAIGHT', status: VEHICLE_STATUSES.CROSSING, atStopLine: false, routeDistance: 20 },
  });
  const snapshot = buildTrafficSnapshot({
    tickId: 'decision-crossing',
    scenarioId: 'traffic-scenario-0',
    simulation,
    eligibleVehicleIds: ['V001'],
  });

  assert.equal(snapshot.intersection.occupancy.known, true);
  assert.deepEqual(snapshot.intersection.currentlyCrossingVehicleIds, ['V011']);
  assert.deepEqual(snapshot.intersection.occupancy.occupiedZones, ['active-route-envelope:V011']);
  assert.equal(snapshot.intersection.conflictInformation.available, true);
  assert.equal(
    snapshot.intersection.conflictInformation.compatibilityNotes.includes('V001 conflicts with currently crossing V011.'),
    true,
  );
});

test('traffic snapshot distinguishes conflicting and non-conflicting eligible route pairs', () => {
  const conflictingSnapshot = buildTrafficSnapshot({
    tickId: 'decision-conflicting',
    scenarioId: 'traffic-scenario-0',
    simulation: simulationWithVehicles({
      V001: { incomingDirection: 'NORTH', route: 'STRAIGHT', status: VEHICLE_STATUSES.WAITING, atStopLine: true },
      V011: { incomingDirection: 'EAST', route: 'STRAIGHT', status: VEHICLE_STATUSES.WAITING, atStopLine: true },
    }),
    eligibleVehicleIds: ['V001', 'V011'],
  });
  const compatibleSnapshot = buildTrafficSnapshot({
    tickId: 'decision-compatible',
    scenarioId: 'traffic-scenario-0',
    simulation: simulationWithVehicles({
      V001: { incomingDirection: 'NORTH', route: 'RIGHT', status: VEHICLE_STATUSES.WAITING, atStopLine: true },
      V011: { incomingDirection: 'EAST', route: 'RIGHT', status: VEHICLE_STATUSES.WAITING, atStopLine: true },
    }),
    eligibleVehicleIds: ['V001', 'V011'],
  });

  assert.equal(
    conflictingSnapshot.intersection.conflictInformation.compatibilityNotes.includes(
      'V001 conflicts with V011; do not recommend GO for both in this tick.',
    ),
    true,
  );
  assert.equal(
    compatibleSnapshot.intersection.conflictInformation.compatibilityNotes.includes(
      'V001 and V011 are geometry-compatible and may be considered together.',
    ),
    true,
  );
});

test('traffic snapshot leaves occupancy and compatibility unknown when live state is incomplete', () => {
  const simulation = simulationWithVehicles({}, [{ id: 'incomplete-vehicle' }]);
  const snapshot = buildTrafficSnapshot({
    tickId: 'decision-incomplete',
    scenarioId: 'traffic-scenario-0',
    simulation,
    eligibleVehicleIds: [],
  });

  assert.equal(snapshot.intersection.occupancy.known, false);
  assert.deepEqual(snapshot.intersection.occupancy.occupiedZones, []);
  assert.equal(snapshot.intersection.conflictInformation.available, false);
  assert.match(snapshot.intersection.conflictInformation.compatibilityNotes[0], /occupancy state is incomplete/);
});

test('AI request service makes one proxied POST request and returns proposals without movement commands', async () => {
  let callCount = 0;
  const result = await requestAiDecisions({ tickId: 'decision-0-1' }, async (url, options) => {
    callCount += 1;
    assert.equal(url, '/api/ai/decision');
    assert.equal(options.method, 'POST');
    assert.equal(JSON.parse(options.body).tickId, 'decision-0-1');
    return {
      ok: true,
      json: async () => ({
        success: true,
        data: {
          tickId: 'decision-0-1',
          decisions: [{ vehicleId: 'V001', action: 'GO', reasonCode: 'PRIORITY' }],
          model: 'gemini-3.8-flash',
          latencyMs: 12,
        },
      }),
    };
  });

  assert.equal(callCount, 1);
  assert.equal(result.decisions[0].action, 'GO');
});

test('AI request service exposes controlled network and API failures', async () => {
  await assert.rejects(
    () => requestAiDecisions({}, async () => { throw new Error('offline'); }),
    (error) => error.code === 'AI_NETWORK_ERROR',
  );
  await assert.rejects(
    () => requestAiDecisions({}, async () => ({
      ok: false,
      json: async () => ({ success: false, error: { code: 'GEMINI_TIMEOUT', message: 'Gemini request timed out.' } }),
    })),
    (error) => error.code === 'GEMINI_TIMEOUT',
  );
});
