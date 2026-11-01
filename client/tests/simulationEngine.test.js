import assert from 'node:assert/strict';
import test from 'node:test';
import {
  approveVehicleMovement,
  getEligibleVehicles,
  SIMULATION_STATUSES,
  startApprovedVehicleMovements,
} from '../src/services/simulationEngine.js';
import { VEHICLE_STATUSES } from '../src/services/vehicleGenerator.js';

function vehicle({
  id,
  incomingDirection = 'NORTH',
  route = 'STRAIGHT',
  queuePosition = 0,
  status = VEHICLE_STATUSES.WAITING,
  atStopLine = true,
}) {
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

function state(status, vehicles) {
  return { status, vehicles, elapsedTime: 0 };
}

test('returns eligible queue-head vehicles while running', () => {
  const simulation = state(SIMULATION_STATUSES.RUNNING, [
    vehicle({ id: 'V001', incomingDirection: 'NORTH' }),
    vehicle({ id: 'V002', incomingDirection: 'NORTH', queuePosition: 1 }),
    vehicle({ id: 'V003', incomingDirection: 'SOUTH' }),
  ]);

  assert.deepEqual(getEligibleVehicles(simulation).map((item) => item.id), ['V001', 'V003']);
});

test('returns the same eligible queue-head vehicles while paused', () => {
  const vehicles = [
    vehicle({ id: 'V001', incomingDirection: 'NORTH' }),
    vehicle({ id: 'V002', incomingDirection: 'NORTH', queuePosition: 1 }),
    vehicle({ id: 'V003', incomingDirection: 'SOUTH' }),
  ];

  assert.deepEqual(
    getEligibleVehicles(state(SIMULATION_STATUSES.PAUSED, vehicles)).map((item) => item.id),
    getEligibleVehicles(state(SIMULATION_STATUSES.RUNNING, vehicles)).map((item) => item.id),
  );
});

test('returns no vehicles when none satisfy eligibility conditions', () => {
  const simulation = state(SIMULATION_STATUSES.RUNNING, [
    vehicle({ id: 'V001', status: VEHICLE_STATUSES.APPROACHING, atStopLine: false }),
    vehicle({ id: 'V002', queuePosition: 1 }),
    vehicle({ id: 'V003', incomingDirection: 'SOUTH', atStopLine: false }),
  ]);

  assert.deepEqual(getEligibleVehicles(simulation), []);
});

test('blocks movement approval while paused', () => {
  const simulation = state(SIMULATION_STATUSES.PAUSED, [vehicle({ id: 'V001' })]);
  const result = approveVehicleMovement(simulation, 'V001');

  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'SIMULATION_NOT_RUNNING');
  assert.equal(result.state, simulation);
});

test('approves an eligible vehicle while running', () => {
  const simulation = state(SIMULATION_STATUSES.RUNNING, [vehicle({ id: 'V001' })]);
  const result = approveVehicleMovement(simulation, 'V001');

  assert.equal(result.accepted, true);
  assert.equal(result.state.vehicles[0].status, VEHICLE_STATUSES.CROSSING);
});

test('starts a non-conflicting approved batch without a global crossing restriction', () => {
  const simulation = state(SIMULATION_STATUSES.RUNNING, [
    vehicle({ id: 'V001', incomingDirection: 'NORTH', route: 'RIGHT' }),
    vehicle({ id: 'V006', incomingDirection: 'SOUTH', route: 'RIGHT' }),
  ]);

  const result = startApprovedVehicleMovements(simulation, ['V001', 'V006']);

  assert.equal(result.accepted, true);
  assert.equal(result.state.vehicles.every((item) => item.status === VEHICLE_STATUSES.CROSSING), true);
});

test('atomically rejects a conflicting approved batch', () => {
  const simulation = state(SIMULATION_STATUSES.RUNNING, [
    vehicle({ id: 'V001', incomingDirection: 'NORTH' }),
    vehicle({ id: 'V011', incomingDirection: 'EAST' }),
  ]);

  const result = startApprovedVehicleMovements(simulation, ['V001', 'V011']);

  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'MOVEMENT_CONFLICT');
  assert.equal(result.state, simulation);
});
