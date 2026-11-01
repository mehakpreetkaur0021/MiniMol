import assert from 'node:assert/strict';
import test from 'node:test';
import { getEligibleVehicles, SIMULATION_STATUSES } from '../src/services/simulationEngine.js';
import { executeApprovedVehicleMovements } from '../src/services/movementExecutionService.js';
import { validateMovementProposals } from '../src/services/safetyValidator.js';
import { buildTrafficSnapshot } from '../src/services/trafficSnapshotBuilder.js';
import { VEHICLE_STATUSES } from '../src/services/vehicleGenerator.js';

const TICK_ID = 'decision-0-1';
const SCENARIO_ID = 'traffic-scenario-0';

function vehicle({
  id = 'V001',
  incomingDirection = 'NORTH',
  route = 'STRAIGHT',
  queuePosition = 0,
  status = VEHICLE_STATUSES.WAITING,
  atStopLine = true,
} = {}) {
  return {
    id,
    incomingDirection,
    route,
    queuePosition,
    status,
    atStopLine,
    waitingTime: 0,
    speed: 0,
    routeDistance: 0,
    x: 0,
    y: 0,
    heading: 0,
  };
}

function simulation(vehicles = [vehicle()], status = SIMULATION_STATUSES.RUNNING) {
  return { vehicles, status, elapsedTime: 0 };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function snapshotFor(currentSimulation, overrides = {}) {
  return {
    ...buildTrafficSnapshot({
      tickId: TICK_ID,
      scenarioId: SCENARIO_ID,
      simulation: currentSimulation,
      eligibleVehicleIds: getEligibleVehicles(currentSimulation).map((item) => item.id),
    }),
    ...overrides,
  };
}

function validate({
  currentSimulation = simulation(),
  snapshot = snapshotFor(currentSimulation),
  proposal = { tickId: TICK_ID, decisions: [{ vehicleId: 'V001', action: 'GO' }] },
  currentTickId = TICK_ID,
  currentScenarioId = SCENARIO_ID,
  authorizedVehicleIds,
} = {}) {
  return validateMovementProposals({
    proposal,
    snapshot,
    simulation: currentSimulation,
    currentTickId,
    currentScenarioId,
    authorizedVehicleIds,
  });
}

function resultOf(validation, vehicleId = 'V001') {
  return validation.results.find((result) => result.vehicleId === vehicleId);
}

test('approves a valid GO proposal when all safety conditions pass', () => {
  const result = resultOf(validate());

  assert.deepEqual(result, {
    vehicleId: 'V001',
    aiProposal: 'GO',
    safetyStatus: 'APPROVED',
    authorized: true,
    reason: 'ALL_SAFETY_CHECKS_PASSED',
  });
});

test('WAIT proposals never authorize movement', () => {
  const result = resultOf(validate({ proposal: { tickId: TICK_ID, decisions: [{ vehicleId: 'V001', action: 'WAIT' }] } }));

  assert.equal(result.safetyStatus, 'WAITING');
  assert.equal(result.authorized, false);
  assert.equal(result.reason, 'AI_WAIT');
});

test('rejects GO while the simulation is paused', () => {
  const currentSimulation = simulation([vehicle()], SIMULATION_STATUSES.PAUSED);
  assert.equal(resultOf(validate({ currentSimulation })).reason, 'SIMULATION_NOT_RUNNING');
});

test('rejects GO while the simulation is stopped', () => {
  const currentSimulation = simulation([vehicle()], SIMULATION_STATUSES.STOPPED);
  assert.equal(resultOf(validate({ currentSimulation })).reason, 'SIMULATION_NOT_RUNNING');
});

test('rejects an unknown vehicle ID', () => {
  const result = resultOf(validate({ proposal: { tickId: TICK_ID, decisions: [{ vehicleId: 'V999', action: 'GO' }] } }), 'V999');
  assert.equal(result.reason, 'VEHICLE_NOT_FOUND');
});

test('rejects a vehicle not at the stop line', () => {
  const currentSimulation = simulation([vehicle({ atStopLine: false })]);
  assert.equal(resultOf(validate({ currentSimulation })).reason, 'VEHICLE_NOT_AT_STOP_LINE');
});

test('rejects a vehicle not in WAITING state', () => {
  const currentSimulation = simulation([vehicle({ status: VEHICLE_STATUSES.APPROACHING, atStopLine: false })]);
  assert.equal(resultOf(validate({ currentSimulation })).reason, 'VEHICLE_NOT_WAITING');
});

test('rejects a vehicle that is not at its approach queue head', () => {
  const currentSimulation = simulation([
    vehicle({ id: 'V001', queuePosition: 0 }),
    vehicle({ id: 'V002', queuePosition: 1 }),
  ]);
  const result = resultOf(validate({
    currentSimulation,
    proposal: { tickId: TICK_ID, decisions: [{ vehicleId: 'V002', action: 'GO' }] },
  }), 'V002');

  assert.equal(result.reason, 'VEHICLE_NOT_QUEUE_HEAD');
});

test('rejects a vehicle whose snapshot eligibility is no longer valid', () => {
  const currentSimulation = simulation();
  const snapshot = snapshotFor(currentSimulation, { eligibleVehicleIds: [] });
  assert.equal(resultOf(validate({ currentSimulation, snapshot })).reason, 'VEHICLE_NOT_ELIGIBLE');
});

test('rejects a stale decision tick', () => {
  assert.equal(resultOf(validate({ currentTickId: 'decision-0-2' })).reason, 'STALE_TICK');
});

test('rejects a current vehicle whose eligibility-critical state changed after the snapshot', () => {
  const snapshot = snapshotFor(simulation());
  const currentSimulation = simulation([vehicle({ route: 'LEFT' })]);

  assert.equal(resultOf(validate({ currentSimulation, snapshot })).reason, 'STALE_SIMULATION_STATE');
});

test('rejects a scenario mismatch', () => {
  assert.equal(resultOf(validate({ currentScenarioId: 'traffic-scenario-1' })).reason, 'SCENARIO_MISMATCH');
});

test('rejects a vehicle absent from the original snapshot', () => {
  const currentSimulation = simulation();
  const snapshot = snapshotFor(currentSimulation, { vehicles: [] });
  assert.equal(resultOf(validate({ currentSimulation, snapshot })).reason, 'VEHICLE_NOT_IN_SNAPSHOT');
});

test('rejects a candidate that conflicts with an already crossing vehicle', () => {
  const currentSimulation = simulation([
    vehicle({ id: 'V001', incomingDirection: 'NORTH' }),
    vehicle({
      id: 'V011',
      incomingDirection: 'EAST',
      status: VEHICLE_STATUSES.CROSSING,
      atStopLine: false,
    }),
  ]);
  assert.equal(resultOf(validate({ currentSimulation })).reason, 'INTERSECTION_OCCUPIED');
});

test('approves an independent path despite a verified non-conflicting crossing vehicle', () => {
  const currentSimulation = simulation([
    vehicle({ id: 'V001', incomingDirection: 'NORTH', route: 'RIGHT' }),
    vehicle({
      id: 'V006',
      incomingDirection: 'SOUTH',
      route: 'RIGHT',
      status: VEHICLE_STATUSES.CROSSING,
      atStopLine: false,
    }),
  ]);

  assert.equal(resultOf(validate({ currentSimulation })).safetyStatus, 'APPROVED');
});

test('rejects movement when occupancy information is unavailable', () => {
  const currentSimulation = simulation();
  const snapshot = snapshotFor(currentSimulation);
  delete snapshot.intersection.currentlyCrossingVehicleIds;

  assert.equal(resultOf(validate({ currentSimulation, snapshot })).reason, 'OCCUPANCY_UNAVAILABLE');
});

test('approves two non-conflicting GO proposals', () => {
  const currentSimulation = simulation([
    vehicle({ id: 'V001', incomingDirection: 'NORTH', route: 'RIGHT' }),
    vehicle({ id: 'V006', incomingDirection: 'SOUTH', route: 'RIGHT' }),
  ]);
  const results = validate({
    currentSimulation,
    proposal: {
      tickId: TICK_ID,
      decisions: [{ vehicleId: 'V001', action: 'GO' }, { vehicleId: 'V006', action: 'GO' }],
    },
  }).results;

  assert.equal(resultOf({ results }, 'V001').reason, 'ALL_SAFETY_CHECKS_PASSED');
  assert.equal(resultOf({ results }, 'V006').reason, 'ALL_SAFETY_CHECKS_PASSED');
});

test('approves three mutually non-conflicting GO proposals', () => {
  const currentSimulation = simulation([
    vehicle({ id: 'V001', incomingDirection: 'NORTH', route: 'RIGHT' }),
    vehicle({ id: 'V006', incomingDirection: 'SOUTH', route: 'RIGHT' }),
    vehicle({ id: 'V011', incomingDirection: 'EAST', route: 'RIGHT' }),
  ]);
  const validation = validate({
    currentSimulation,
    proposal: {
      tickId: TICK_ID,
      decisions: [{ vehicleId: 'V011', action: 'GO' }, { vehicleId: 'V006', action: 'GO' }, { vehicleId: 'V001', action: 'GO' }],
    },
  });

  assert.equal(validation.results.filter((result) => result.authorized).length, 3);
  assert.equal(validation.results.every((result) => result.safetyStatus === 'APPROVED'), true);
});

test('rejects a later GO whose route conflicts with an approved movement', () => {
  const currentSimulation = simulation([
    vehicle({ id: 'V001', incomingDirection: 'NORTH', route: 'STRAIGHT' }),
    vehicle({ id: 'V011', incomingDirection: 'EAST', route: 'STRAIGHT' }),
  ]);
  const validation = validate({
    currentSimulation,
    proposal: { tickId: TICK_ID, decisions: [{ vehicleId: 'V011', action: 'GO' }, { vehicleId: 'V001', action: 'GO' }] },
  });

  assert.equal(resultOf(validation, 'V001').safetyStatus, 'APPROVED');
  assert.equal(resultOf(validation, 'V011').reason, 'MOVEMENT_CONFLICT');
});

test('fails closed when a movement has incomplete geometry', () => {
  const currentSimulation = simulation([vehicle({ route: 'UNSUPPORTED' })]);
  assert.equal(resultOf(validate({ currentSimulation })).reason, 'MOVEMENT_GEOMETRY_UNAVAILABLE');
});

test('rejects duplicate vehicle IDs in a proposal', () => {
  const validation = validate({
    proposal: { tickId: TICK_ID, decisions: [{ vehicleId: 'V001', action: 'GO' }, { vehicleId: 'V001', action: 'GO' }] },
  });

  assert.equal(validation.results.every((result) => result.reason === 'DUPLICATE_VEHICLE_ID'), true);
});

test('does not authorize a vehicle that has already been authorized', () => {
  assert.equal(resultOf(validate({ authorizedVehicleIds: ['V001'] })).reason, 'ALREADY_AUTHORIZED');
});

test('invalidates a pre-reset or pre-scenario-change approval context', () => {
  assert.equal(resultOf(validate({ currentScenarioId: 'traffic-scenario-1' })).reason, 'SCENARIO_MISMATCH');
});

test('manual approval can use a deterministic authorization through Module 8', () => {
  const currentSimulation = simulation();
  const safetyValidation = validate({ currentSimulation });
  const safetyResult = resultOf(safetyValidation);
  const movement = executeApprovedVehicleMovements(currentSimulation, {
    safetyValidation,
    currentTickId: TICK_ID,
    currentScenarioId: SCENARIO_ID,
  });

  assert.equal(safetyResult.authorized, true);
  assert.equal(movement.results[0].executionStatus, 'STARTED');
  assert.equal(movement.state.vehicles[0].status, VEHICLE_STATUSES.CROSSING);
});

test('AI proposal validation never changes simulation positions or vehicle states', () => {
  const currentSimulation = simulation();
  const before = clone(currentSimulation);

  validate({ currentSimulation });

  assert.deepEqual(currentSimulation, before);
});
