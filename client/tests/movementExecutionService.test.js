import assert from 'node:assert/strict';
import test from 'node:test';
import {
  advanceSimulation,
  createSimulationState,
  getEligibleVehicles,
  SIMULATION_STATUSES,
} from '../src/services/simulationEngine.js';
import {
  executeApprovedVehicleMovements,
  getAuthorizationExecutionId,
} from '../src/services/movementExecutionService.js';
import { getRoutePath } from '../src/services/routeGeometry.js';
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
  routeDistance = 0,
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
    routeDistance,
    x: 0,
    y: 0,
    heading: 0,
  };
}

function simulation(vehicles = [vehicle()], status = SIMULATION_STATUSES.RUNNING) {
  return { vehicles, status, elapsedTime: 0 };
}

function authorize(currentSimulation, decisions, { tickId = TICK_ID, scenarioId = SCENARIO_ID } = {}) {
  const snapshot = buildTrafficSnapshot({
    tickId,
    scenarioId,
    simulation: currentSimulation,
    eligibleVehicleIds: getEligibleVehicles(currentSimulation).map((item) => item.id),
  });
  return validateMovementProposals({
    proposal: { tickId, decisions },
    snapshot,
    simulation: currentSimulation,
    currentTickId: tickId,
    currentScenarioId: scenarioId,
  });
}

function execute(currentSimulation, safetyValidation, options = {}) {
  return executeApprovedVehicleMovements(currentSimulation, {
    safetyValidation,
    currentTickId: options.tickId ?? TICK_ID,
    currentScenarioId: options.scenarioId ?? SCENARIO_ID,
    executedAuthorizationIds: options.executedAuthorizationIds,
  });
}

function statuses(state) {
  return Object.fromEntries(state.vehicles.map((item) => [item.id, item.status]));
}

test('starts one Module 7-authorized vehicle', () => {
  const currentSimulation = simulation();
  const safetyValidation = authorize(currentSimulation, [{ vehicleId: 'V001', action: 'GO' }]);
  const execution = execute(currentSimulation, safetyValidation);

  assert.equal(execution.results[0].executionStatus, 'STARTED');
  assert.equal(execution.state.vehicles[0].status, VEHICLE_STATUSES.CROSSING);
});

test('starts two non-conflicting authorized vehicles simultaneously', () => {
  const currentSimulation = simulation([
    vehicle({ id: 'V001', incomingDirection: 'NORTH', route: 'RIGHT' }),
    vehicle({ id: 'V006', incomingDirection: 'SOUTH', route: 'RIGHT' }),
  ]);
  const safetyValidation = authorize(currentSimulation, [
    { vehicleId: 'V001', action: 'GO' },
    { vehicleId: 'V006', action: 'GO' },
  ]);
  const execution = execute(currentSimulation, safetyValidation);

  assert.deepEqual(statuses(execution.state), { V001: 'CROSSING', V006: 'CROSSING' });
  assert.equal(execution.results.filter((result) => result.executionStatus === 'STARTED').length, 2);
});

test('starts three mutually non-conflicting authorized vehicles simultaneously', () => {
  const currentSimulation = simulation([
    vehicle({ id: 'V001', incomingDirection: 'NORTH', route: 'RIGHT' }),
    vehicle({ id: 'V006', incomingDirection: 'SOUTH', route: 'RIGHT' }),
    vehicle({ id: 'V011', incomingDirection: 'EAST', route: 'RIGHT' }),
  ]);
  const safetyValidation = authorize(currentSimulation, [
    { vehicleId: 'V011', action: 'GO' },
    { vehicleId: 'V006', action: 'GO' },
    { vehicleId: 'V001', action: 'GO' },
  ]);
  const execution = execute(currentSimulation, safetyValidation);

  assert.equal(execution.state.vehicles.every((item) => item.status === VEHICLE_STATUSES.CROSSING), true);
  assert.equal(execution.results.filter((result) => result.executionStatus === 'STARTED').length, 3);
});

test('does not start both vehicles from conflicting authorization results', () => {
  const currentSimulation = simulation([
    vehicle({ id: 'V001', incomingDirection: 'NORTH', route: 'STRAIGHT' }),
    vehicle({ id: 'V011', incomingDirection: 'EAST', route: 'STRAIGHT' }),
  ]);
  const safetyValidation = authorize(currentSimulation, [
    { vehicleId: 'V001', action: 'GO' },
    { vehicleId: 'V011', action: 'GO' },
  ]);
  const execution = execute(currentSimulation, safetyValidation);

  assert.equal(execution.results.filter((result) => result.executionStatus === 'STARTED').length, 1);
  assert.equal(statuses(execution.state).V011, VEHICLE_STATUSES.WAITING);
});

test('does not start a movement that conflicts with an active crossing vehicle', () => {
  const currentSimulation = simulation([
    vehicle({ id: 'V001', incomingDirection: 'NORTH', route: 'STRAIGHT' }),
    vehicle({ id: 'V011', incomingDirection: 'EAST', route: 'STRAIGHT', status: VEHICLE_STATUSES.CROSSING, atStopLine: false }),
  ]);
  const safetyValidation = authorize(currentSimulation, [{ vehicleId: 'V001', action: 'GO' }]);
  const execution = execute(currentSimulation, safetyValidation);

  assert.equal(execution.results[0].reason, 'NOT_AUTHORIZED');
  assert.equal(statuses(execution.state).V001, VEHICLE_STATUSES.WAITING);
});

test('starts an independent movement while another vehicle is crossing', () => {
  const currentSimulation = simulation([
    vehicle({ id: 'V001', incomingDirection: 'NORTH', route: 'RIGHT' }),
    vehicle({ id: 'V006', incomingDirection: 'SOUTH', route: 'RIGHT', status: VEHICLE_STATUSES.CROSSING, atStopLine: false }),
  ]);
  const safetyValidation = authorize(currentSimulation, [{ vehicleId: 'V001', action: 'GO' }]);
  const execution = execute(currentSimulation, safetyValidation);

  assert.equal(execution.results[0].executionStatus, 'STARTED');
  assert.deepEqual(statuses(execution.state), { V001: 'CROSSING', V006: 'CROSSING' });
});

test('WAIT and rejected Module 7 decisions do not execute', () => {
  const waitingSimulation = simulation();
  const waitValidation = authorize(waitingSimulation, [{ vehicleId: 'V001', action: 'WAIT' }]);
  assert.equal(execute(waitingSimulation, waitValidation).results[0].reason, 'NOT_AUTHORIZED');

  const rejectedSimulation = simulation([vehicle({ atStopLine: false })]);
  const rejectedValidation = authorize(rejectedSimulation, [{ vehicleId: 'V001', action: 'GO' }]);
  assert.equal(execute(rejectedSimulation, rejectedValidation).results[0].reason, 'NOT_AUTHORIZED');
});

test('rejects raw or missing authorization objects', () => {
  const currentSimulation = simulation();
  const rawProposal = {
    tickId: TICK_ID,
    scenarioId: SCENARIO_ID,
    results: [{ vehicleId: 'V001', authorized: true }],
  };

  assert.equal(execute(currentSimulation, rawProposal).results[0].reason, 'UNVERIFIED_AUTHORIZATION');
  assert.deepEqual(execute(currentSimulation).results, []);
});

test('rejects stale ticks and scenario mismatches before execution', () => {
  const currentSimulation = simulation();
  const safetyValidation = authorize(currentSimulation, [{ vehicleId: 'V001', action: 'GO' }]);

  assert.equal(execute(currentSimulation, safetyValidation, { tickId: 'decision-0-2' }).results[0].reason, 'STALE_TICK');
  assert.equal(execute(currentSimulation, safetyValidation, { scenarioId: 'traffic-scenario-1' }).results[0].reason, 'SCENARIO_MISMATCH');
});

test('execution is idempotent for a repeated validation result', () => {
  const currentSimulation = simulation();
  const safetyValidation = authorize(currentSimulation, [{ vehicleId: 'V001', action: 'GO' }]);
  const firstExecution = execute(currentSimulation, safetyValidation);
  const secondExecution = execute(firstExecution.state, safetyValidation);

  assert.equal(firstExecution.results[0].executionStatus, 'STARTED');
  assert.equal(secondExecution.results[0].reason, 'ALREADY_EXECUTED');
  assert.equal(secondExecution.state, firstExecution.state);
});

test('fails closed for invalid geometry and missing occupancy data', () => {
  const invalidGeometrySimulation = simulation([vehicle({ route: 'UNSUPPORTED' })]);
  const invalidGeometryValidation = authorize(invalidGeometrySimulation, [{ vehicleId: 'V001', action: 'GO' }]);
  assert.equal(execute(invalidGeometrySimulation, invalidGeometryValidation).results[0].reason, 'NOT_AUTHORIZED');

  const currentSimulation = simulation();
  const snapshot = buildTrafficSnapshot({
    tickId: TICK_ID,
    scenarioId: SCENARIO_ID,
    simulation: currentSimulation,
    eligibleVehicleIds: ['V001'],
  });
  delete snapshot.intersection.currentlyCrossingVehicleIds;
  const missingOccupancyValidation = validateMovementProposals({
    proposal: { tickId: TICK_ID, decisions: [{ vehicleId: 'V001', action: 'GO' }] },
    snapshot,
    simulation: currentSimulation,
    currentTickId: TICK_ID,
    currentScenarioId: SCENARIO_ID,
  });
  assert.equal(execute(currentSimulation, missingOccupancyValidation).results[0].reason, 'NOT_AUTHORIZED');
});

test('paused and stopped simulations reject new movement starts', () => {
  for (const status of [SIMULATION_STATUSES.PAUSED, SIMULATION_STATUSES.STOPPED]) {
    const currentSimulation = simulation([vehicle()], status);
    const safetyValidation = authorize(currentSimulation, [{ vehicleId: 'V001', action: 'GO' }]);
    assert.equal(execute(currentSimulation, safetyValidation).results[0].reason, 'NOT_AUTHORIZED');
  }
});

test('paused and stopped simulations do not advance crossing vehicles', () => {
  const crossingVehicle = vehicle({
    status: VEHICLE_STATUSES.CROSSING,
    atStopLine: false,
    routeDistance: 20,
  });
  for (const status of [SIMULATION_STATUSES.PAUSED, SIMULATION_STATUSES.STOPPED]) {
    const currentSimulation = simulation([{ ...crossingVehicle }], status);
    assert.equal(advanceSimulation(currentSimulation, 0.1), currentSimulation);
  }
});

test('multiple crossing vehicles progress independently during one simulation tick', () => {
  const currentSimulation = simulation([
    vehicle({ id: 'V001', incomingDirection: 'NORTH', route: 'RIGHT' }),
    vehicle({ id: 'V006', incomingDirection: 'SOUTH', route: 'RIGHT' }),
    vehicle({ id: 'V011', incomingDirection: 'EAST', route: 'RIGHT' }),
  ]);
  const validation = authorize(currentSimulation, [
    { vehicleId: 'V001', action: 'GO' },
    { vehicleId: 'V006', action: 'GO' },
    { vehicleId: 'V011', action: 'GO' },
  ]);
  const started = execute(currentSimulation, validation).state;
  const advanced = advanceSimulation(started, 0.1);

  assert.equal(advanced.vehicles.filter((item) => item.status === VEHICLE_STATUSES.CROSSING).length, 3);
  assert.equal(advanced.vehicles.every((item) => item.routeDistance > 0), true);
  assert.equal(new Set(advanced.vehicles.map((item) => `${item.x}:${item.y}`)).size, 3);
});

test('one completed vehicle does not stop another crossing vehicle', () => {
  const northPath = getRoutePath('NORTH', 'RIGHT');
  const currentSimulation = simulation([
    vehicle({
      id: 'V001', incomingDirection: 'NORTH', route: 'RIGHT', status: VEHICLE_STATUSES.CROSSING, atStopLine: false,
      routeDistance: northPath.totalLength - 1,
    }),
    vehicle({ id: 'V006', incomingDirection: 'SOUTH', route: 'RIGHT', status: VEHICLE_STATUSES.CROSSING, atStopLine: false }),
  ]);
  const advanced = advanceSimulation(currentSimulation, 0.1);

  assert.equal(statuses(advanced).V001, VEHICLE_STATUSES.EXITED);
  assert.equal(statuses(advanced).V006, VEHICLE_STATUSES.CROSSING);
  assert.equal(advanced.vehicles.find((item) => item.id === 'V006').routeDistance > 0, true);
});

test('occupancy reports all crossing vehicles and releases each when they exit', () => {
  const currentSimulation = simulation([
    vehicle({ id: 'V001', incomingDirection: 'NORTH', route: 'RIGHT' }),
    vehicle({ id: 'V006', incomingDirection: 'SOUTH', route: 'RIGHT' }),
  ]);
  const started = execute(currentSimulation, authorize(currentSimulation, [
    { vehicleId: 'V001', action: 'GO' },
    { vehicleId: 'V006', action: 'GO' },
  ])).state;
  const firstExited = {
    ...started,
    vehicles: started.vehicles.map((item) => (
      item.id === 'V001'
        ? { ...item, routeDistance: getRoutePath(item.incomingDirection, item.route).totalLength - 1 }
        : item
    )),
  };
  const advanced = advanceSimulation(firstExited, 0.1);
  const occupancy = buildTrafficSnapshot({
    tickId: TICK_ID,
    scenarioId: SCENARIO_ID,
    simulation: advanced,
    eligibleVehicleIds: [],
  }).intersection.currentlyCrossingVehicleIds;

  assert.deepEqual(occupancy, ['V006']);
});

test('the reset-state factory clears in-progress movement', () => {
  const originalVehicles = [vehicle({ id: 'V001', incomingDirection: 'NORTH', route: 'RIGHT' })];
  const started = execute(simulation(originalVehicles), authorize(simulation(originalVehicles), [{ vehicleId: 'V001', action: 'GO' }])).state;
  const resetState = createSimulationState(originalVehicles);

  assert.equal(started.vehicles[0].status, VEHICLE_STATUSES.CROSSING);
  assert.equal(resetState.status, SIMULATION_STATUSES.STOPPED);
  assert.equal(resetState.vehicles[0].status, VEHICLE_STATUSES.APPROACHING);
  assert.equal(resetState.vehicles[0].routeDistance, 0);
});

test('execution identifiers associate starts with scenario, tick, and vehicle', () => {
  assert.equal(getAuthorizationExecutionId(SCENARIO_ID, TICK_ID, 'V001'), 'traffic-scenario-0:decision-0-1:V001');
});
