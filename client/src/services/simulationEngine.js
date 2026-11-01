import { INCOMING_LANES } from './intersectionGeometry.js';
import { getInitialHeading, getPointOnPath, getRoutePath, getStopPoint } from './routeGeometry.js';
import { SIMULATION_CONFIG } from './simulationConfig.js';
import { VEHICLE_DIRECTIONS, VEHICLE_STATUSES } from './vehicleGenerator.js';

export const SIMULATION_STATUSES = Object.freeze({
  STOPPED: 'STOPPED',
  RUNNING: 'RUNNING',
  PAUSED: 'PAUSED',
});

function resetVehicle(vehicle) {
  return {
    ...vehicle,
    status: VEHICLE_STATUSES.APPROACHING,
    atStopLine: false,
    waitingTime: 0,
    speed: 0,
    routeDistance: 0,
    heading: getInitialHeading(vehicle.incomingDirection),
  };
}

export function createSimulationState(vehicles) {
  return {
    vehicles: vehicles.map(resetVehicle),
    elapsedTime: 0,
    status: SIMULATION_STATUSES.STOPPED,
  };
}

export function startSimulation(state) {
  if (state.status === SIMULATION_STATUSES.RUNNING) {
    return state;
  }

  return { ...state, status: SIMULATION_STATUSES.RUNNING };
}

export function pauseSimulation(state) {
  if (state.status !== SIMULATION_STATUSES.RUNNING) {
    return state;
  }

  return { ...state, status: SIMULATION_STATUSES.PAUSED };
}

function moveTowards(current, target, maximumDistance) {
  const difference = target - current;

  if (Math.abs(difference) <= maximumDistance) {
    return target;
  }

  return current + Math.sign(difference) * maximumDistance;
}

function getLaneCoordinate(vehicle) {
  const lane = INCOMING_LANES[vehicle.incomingDirection];
  return lane.axis === 'vertical' ? vehicle.y : vehicle.x;
}

function applyLaneCoordinate(vehicle, coordinate) {
  const lane = INCOMING_LANES[vehicle.incomingDirection];
  return lane.axis === 'vertical' ? { ...vehicle, y: coordinate } : { ...vehicle, x: coordinate };
}

function updateApproachQueue(vehicles, deltaSeconds) {
  let updatedVehicles = [...vehicles];

  VEHICLE_DIRECTIONS.forEach((incomingDirection) => {
    const lane = INCOMING_LANES[incomingDirection];
    const queue = updatedVehicles
      .filter((vehicle) => vehicle.incomingDirection === incomingDirection && vehicle.status !== VEHICLE_STATUSES.CROSSING && vehicle.status !== VEHICLE_STATUSES.EXITED)
      .sort((first, second) => first.queuePosition - second.queuePosition);

    queue.forEach((queuedVehicle, index) => {
      const currentVehicle = updatedVehicles.find((vehicle) => vehicle.id === queuedVehicle.id);
      const stopPoint = getStopPoint(incomingDirection);
      const stopCoordinate = lane.axis === 'vertical' ? stopPoint.y : stopPoint.x;
      const vehicleAhead = index === 0 ? null : updatedVehicles.find((vehicle) => vehicle.id === queue[index - 1].id);
      const targetCoordinate = vehicleAhead
        ? getLaneCoordinate(vehicleAhead) + lane.queueDirection * SIMULATION_CONFIG.minimumSafeGap
        : stopCoordinate;
      const currentCoordinate = getLaneCoordinate(currentVehicle);
      const nextCoordinate = moveTowards(
        currentCoordinate,
        targetCoordinate,
        SIMULATION_CONFIG.approachSpeed * deltaSeconds,
      );
      const reachedStopLine = !vehicleAhead && Math.abs(nextCoordinate - stopCoordinate) < 0.001;
      const nextVehicle = applyLaneCoordinate(currentVehicle, nextCoordinate);

      nextVehicle.status = reachedStopLine ? VEHICLE_STATUSES.WAITING : VEHICLE_STATUSES.APPROACHING;
      nextVehicle.atStopLine = reachedStopLine;
      nextVehicle.speed = reachedStopLine ? 0 : SIMULATION_CONFIG.approachSpeed;
      updatedVehicles = updatedVehicles.map((vehicle) => (vehicle.id === nextVehicle.id ? nextVehicle : vehicle));
    });
  });

  return updatedVehicles;
}

function updateCrossingVehicles(vehicles, deltaSeconds) {
  return vehicles.map((vehicle) => {
    if (vehicle.status !== VEHICLE_STATUSES.CROSSING) {
      return vehicle;
    }

    const path = getRoutePath(vehicle.incomingDirection, vehicle.route);
    const routeDistance = Math.min(
      vehicle.routeDistance + SIMULATION_CONFIG.crossingSpeed * deltaSeconds,
      path.totalLength,
    );
    const point = getPointOnPath(path, routeDistance);

    if (routeDistance >= path.totalLength) {
      return {
        ...vehicle,
        x: point.x,
        y: point.y,
        heading: point.heading,
        routeDistance,
        speed: 0,
        status: VEHICLE_STATUSES.EXITED,
        atStopLine: false,
      };
    }

    return {
      ...vehicle,
      x: point.x,
      y: point.y,
      heading: point.heading,
      routeDistance,
      speed: SIMULATION_CONFIG.crossingSpeed,
      atStopLine: false,
    };
  });
}

export function advanceSimulation(state, deltaSeconds) {
  if (state.status !== SIMULATION_STATUSES.RUNNING) {
    return state;
  }

  const safeDelta = Math.max(0, Math.min(deltaSeconds, SIMULATION_CONFIG.maxFrameDeltaSeconds));
  let vehicles = updateCrossingVehicles(state.vehicles, safeDelta);
  vehicles = updateApproachQueue(vehicles, safeDelta);
  vehicles = vehicles.map((vehicle) => (
    vehicle.status === VEHICLE_STATUSES.WAITING
      ? { ...vehicle, waitingTime: vehicle.waitingTime + safeDelta }
      : vehicle
  ));

  return {
    ...state,
    vehicles,
    elapsedTime: state.elapsedTime + safeDelta,
  };
}

export function getEligibleVehicles(state) {
  if (state.status !== SIMULATION_STATUSES.RUNNING) {
    return [];
  }

  return VEHICLE_DIRECTIONS.flatMap((incomingDirection) => {
    const firstQueuedVehicle = state.vehicles
      .filter((vehicle) => vehicle.incomingDirection === incomingDirection && vehicle.status !== VEHICLE_STATUSES.CROSSING && vehicle.status !== VEHICLE_STATUSES.EXITED)
      .sort((first, second) => first.queuePosition - second.queuePosition)[0];

    return firstQueuedVehicle?.status === VEHICLE_STATUSES.WAITING && firstQueuedVehicle.atStopLine
      ? [firstQueuedVehicle]
      : [];
  });
}

export function approveVehicleMovement(state, vehicleId) {
  if (state.status !== SIMULATION_STATUSES.RUNNING) {
    return { accepted: false, reason: 'SIMULATION_NOT_RUNNING', state };
  }

  if (state.vehicles.some((vehicle) => vehicle.status === VEHICLE_STATUSES.CROSSING)) {
    return { accepted: false, reason: 'ANOTHER_VEHICLE_IS_CROSSING', state };
  }

  const vehicle = state.vehicles.find((item) => item.id === vehicleId);
  if (!vehicle) {
    return { accepted: false, reason: 'VEHICLE_NOT_FOUND', state };
  }

  const isEligible = getEligibleVehicles(state).some((eligibleVehicle) => eligibleVehicle.id === vehicleId);
  if (!isEligible) {
    return { accepted: false, reason: 'VEHICLE_NOT_ELIGIBLE', state };
  }

  const path = getRoutePath(vehicle.incomingDirection, vehicle.route);
  const startPoint = getPointOnPath(path, 0);

  return {
    accepted: true,
    state: {
      ...state,
      vehicles: state.vehicles.map((item) => (
        item.id === vehicleId
          ? {
              ...item,
              status: VEHICLE_STATUSES.CROSSING,
              atStopLine: false,
              routeDistance: 0,
              speed: SIMULATION_CONFIG.crossingSpeed,
              x: startPoint.x,
              y: startPoint.y,
              heading: startPoint.heading,
            }
          : item
      )),
    },
  };
}
