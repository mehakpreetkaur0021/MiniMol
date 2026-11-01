import { getMovementConflict } from './movementConflictGeometry.js';
import { VEHICLE_STATUSES } from './vehicleGenerator.js';

export function buildTrafficSnapshot({ tickId, scenarioId, simulation, eligibleVehicleIds }) {
  const vehicles = Array.isArray(simulation?.vehicles) ? simulation.vehicles : [];
  const occupancyKnown = hasCompleteOccupancyState(vehicles);
  const crossingVehicles = vehicles
    .filter((vehicle) => vehicle?.status === VEHICLE_STATUSES.CROSSING)
    .sort((first, second) => String(first.id).localeCompare(String(second.id)));
  const eligibleVehicles = vehicles
    .filter((vehicle) => vehicle && eligibleVehicleIds.includes(vehicle.id))
    .sort((first, second) => String(first.id).localeCompare(String(second.id)));

  return {
    tickId,
    scenarioId,
    simulationTimeSeconds: simulation.elapsedTime,
    intersection: {
      id: 'four-way-intersection',
      currentlyCrossingVehicleIds: crossingVehicles.map((vehicle) => vehicle.id),
      occupancy: {
        known: occupancyKnown,
        occupiedZones: occupancyKnown
          ? crossingVehicles.map((vehicle) => `active-route-envelope:${vehicle.id}`)
          : [],
        dataSource: occupancyKnown
          ? 'simulation CROSSING vehicle states and route envelopes'
          : 'simulation occupancy state incomplete',
      },
      conflictInformation: buildConflictInformation({
        eligibleVehicles,
        crossingVehicles,
        occupancyKnown,
      }),
    },
    vehicles: vehicles.map((vehicle) => ({
      id: vehicle?.id,
      incomingDirection: vehicle?.incomingDirection,
      route: vehicle?.route,
      status: vehicle?.status,
      x: vehicle?.x,
      y: vehicle?.y,
      queuePosition: vehicle?.queuePosition,
      waitingTime: vehicle?.waitingTime,
      speed: vehicle?.speed,
      atStopLine: vehicle?.atStopLine,
    })),
    eligibleVehicleIds: [...eligibleVehicleIds],
  };
}

function hasCompleteOccupancyState(vehicles) {
  return Array.isArray(vehicles)
    && vehicles.length > 0
    && vehicles.every((vehicle) => (
      vehicle
      && typeof vehicle.id === 'string'
      && Object.values(VEHICLE_STATUSES).includes(vehicle.status)
    ));
}

function buildConflictInformation({ eligibleVehicles, crossingVehicles, occupancyKnown }) {
  const compatibilityNotes = [];
  let available = occupancyKnown;

  if (!occupancyKnown) {
    compatibilityNotes.push('Simulation occupancy state is incomplete, so movement compatibility is unavailable.');
    return {
      available,
      source: 'deterministic simulation movement geometry; advisory only',
      compatibilityNotes,
    };
  }

  if (crossingVehicles.length === 0) {
    compatibilityNotes.push('No vehicles are currently crossing in the deterministic simulation state.');
  }

  eligibleVehicles.forEach((eligibleVehicle, index) => {
    crossingVehicles.forEach((crossingVehicle) => {
      const conflict = getMovementConflict(eligibleVehicle, crossingVehicle);
      if (!conflict.known) {
        available = false;
        compatibilityNotes.push(`Geometry is unavailable for ${eligibleVehicle.id} and active vehicle ${crossingVehicle.id}.`);
      } else if (conflict.conflicts) {
        compatibilityNotes.push(`${eligibleVehicle.id} conflicts with currently crossing ${crossingVehicle.id}.`);
      } else {
        compatibilityNotes.push(`${eligibleVehicle.id} is geometry-compatible with currently crossing ${crossingVehicle.id}.`);
      }
    });

    eligibleVehicles.slice(index + 1).forEach((otherEligibleVehicle) => {
      const conflict = getMovementConflict(eligibleVehicle, otherEligibleVehicle);
      if (!conflict.known) {
        available = false;
        compatibilityNotes.push(`Geometry is unavailable for ${eligibleVehicle.id} and ${otherEligibleVehicle.id}.`);
      } else if (conflict.conflicts) {
        compatibilityNotes.push(`${eligibleVehicle.id} conflicts with ${otherEligibleVehicle.id}; do not recommend GO for both in this tick.`);
      } else {
        compatibilityNotes.push(`${eligibleVehicle.id} and ${otherEligibleVehicle.id} are geometry-compatible and may be considered together.`);
      }
    });
  });

  return {
    available,
    source: 'deterministic simulation movement geometry; advisory only',
    compatibilityNotes,
  };
}
