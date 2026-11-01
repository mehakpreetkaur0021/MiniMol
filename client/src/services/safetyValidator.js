import { getEligibleVehicles, SIMULATION_STATUSES } from './simulationEngine.js';
import { getMovementConflict } from './movementConflictGeometry.js';
import { VEHICLE_STATUSES } from './vehicleGenerator.js';

export const SAFETY_STATUSES = Object.freeze({
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  WAITING: 'WAITING',
  NOT_VALIDATED: 'NOT_VALIDATED',
});

const issuedSafetyValidations = new WeakMap();

function createResult(decision, safetyStatus, authorized, reason) {
  return {
    vehicleId: decision?.vehicleId ?? null,
    aiProposal: decision?.action ?? 'UNKNOWN',
    safetyStatus,
    authorized,
    reason,
  };
}

function hasSameIds(firstIds, secondIds) {
  if (!Array.isArray(firstIds) || !Array.isArray(secondIds) || firstIds.length !== secondIds.length) {
    return false;
  }

  const sortedFirstIds = [...firstIds].sort();
  const sortedSecondIds = [...secondIds].sort();
  return sortedFirstIds.every((id, index) => id === sortedSecondIds[index]);
}

function isVehicleStateConsistent(snapshotVehicle, currentVehicle) {
  return Boolean(snapshotVehicle && currentVehicle)
    && snapshotVehicle.incomingDirection === currentVehicle.incomingDirection
    && snapshotVehicle.route === currentVehicle.route
    && snapshotVehicle.status === currentVehicle.status
    && snapshotVehicle.atStopLine === currentVehicle.atStopLine
    && snapshotVehicle.queuePosition === currentVehicle.queuePosition;
}

function getQueueHead(simulation, incomingDirection) {
  return simulation.vehicles
    .filter((vehicle) => vehicle.incomingDirection === incomingDirection
      && vehicle.status !== VEHICLE_STATUSES.CROSSING
      && vehicle.status !== VEHICLE_STATUSES.EXITED)
    .sort((first, second) => first.queuePosition - second.queuePosition)[0];
}

function verifyOccupancy(snapshot, simulation) {
  const snapshotCrossingIds = snapshot?.intersection?.currentlyCrossingVehicleIds;
  if (!Array.isArray(simulation?.vehicles)
    || !Array.isArray(snapshotCrossingIds)
    || new Set(snapshotCrossingIds).size !== snapshotCrossingIds.length) {
    return { valid: false, crossingVehicles: [] };
  }

  const crossingVehicles = simulation.vehicles
    .filter((vehicle) => vehicle.status === VEHICLE_STATUSES.CROSSING)
    .map((vehicle) => vehicle);
  const currentCrossingIds = crossingVehicles.map((vehicle) => vehicle.id);
  if (!hasSameIds(snapshotCrossingIds, currentCrossingIds)) {
    return { valid: false, crossingVehicles: [] };
  }

  const snapshotVehicles = Array.isArray(snapshot?.vehicles) ? snapshot.vehicles : [];
  const crossingStateMatches = crossingVehicles.every((vehicle) => {
    const snapshotVehicle = snapshotVehicles.find((item) => item.id === vehicle.id);
    return snapshotVehicle?.status === VEHICLE_STATUSES.CROSSING
      && snapshotVehicle.incomingDirection === vehicle.incomingDirection
      && snapshotVehicle.route === vehicle.route;
  });
  if (!crossingStateMatches) {
    return { valid: false, crossingVehicles: [] };
  }

  return { valid: true, crossingVehicles };
}

function validateGoDecision({
  decision,
  snapshot,
  simulation,
  currentTickId,
  currentScenarioId,
  authorizedVehicleIds,
  duplicateIds,
  currentEligibleIds,
  snapshotEligibleIds,
  eligibilityMatches,
}) {
  if (duplicateIds.has(decision.vehicleId)) {
    return createResult(decision, SAFETY_STATUSES.REJECTED, false, 'DUPLICATE_VEHICLE_ID');
  }
  if (decision.action === 'WAIT') {
    return createResult(decision, SAFETY_STATUSES.WAITING, false, 'AI_WAIT');
  }
  if (decision.action !== 'GO') {
    return createResult(decision, SAFETY_STATUSES.REJECTED, false, 'INVALID_PROPOSAL_ACTION');
  }
  if (snapshot?.tickId !== decision.tickId || decision.tickId !== currentTickId) {
    return createResult(decision, SAFETY_STATUSES.REJECTED, false, 'STALE_TICK');
  }
  if (snapshot?.scenarioId !== currentScenarioId) {
    return createResult(decision, SAFETY_STATUSES.REJECTED, false, 'SCENARIO_MISMATCH');
  }
  if (simulation?.status !== SIMULATION_STATUSES.RUNNING) {
    return createResult(decision, SAFETY_STATUSES.REJECTED, false, 'SIMULATION_NOT_RUNNING');
  }
  if (!Array.isArray(simulation.vehicles)) {
    return createResult(decision, SAFETY_STATUSES.REJECTED, false, 'INVALID_SIMULATION_STATE');
  }

  const vehicle = simulation.vehicles.find((item) => item.id === decision.vehicleId);
  if (!vehicle) {
    return createResult(decision, SAFETY_STATUSES.REJECTED, false, 'VEHICLE_NOT_FOUND');
  }
  const snapshotVehicle = Array.isArray(snapshot?.vehicles)
    ? snapshot.vehicles.find((item) => item.id === decision.vehicleId)
    : undefined;
  if (!snapshotVehicle) {
    return createResult(decision, SAFETY_STATUSES.REJECTED, false, 'VEHICLE_NOT_IN_SNAPSHOT');
  }
  if (!isVehicleStateConsistent(snapshotVehicle, vehicle)) {
    return createResult(decision, SAFETY_STATUSES.REJECTED, false, 'STALE_SIMULATION_STATE');
  }
  if (authorizedVehicleIds.has(vehicle.id)) {
    return createResult(decision, SAFETY_STATUSES.REJECTED, false, 'ALREADY_AUTHORIZED');
  }
  if (vehicle.status === VEHICLE_STATUSES.EXITED) {
    return createResult(decision, SAFETY_STATUSES.REJECTED, false, 'VEHICLE_ALREADY_EXITED');
  }
  if (vehicle.status !== VEHICLE_STATUSES.WAITING) {
    return createResult(decision, SAFETY_STATUSES.REJECTED, false, 'VEHICLE_NOT_WAITING');
  }
  if (!vehicle.atStopLine) {
    return createResult(decision, SAFETY_STATUSES.REJECTED, false, 'VEHICLE_NOT_AT_STOP_LINE');
  }
  if (getQueueHead(simulation, vehicle.incomingDirection)?.id !== vehicle.id) {
    return createResult(decision, SAFETY_STATUSES.REJECTED, false, 'VEHICLE_NOT_QUEUE_HEAD');
  }
  if (!eligibilityMatches || !snapshotEligibleIds.has(vehicle.id) || !currentEligibleIds.has(vehicle.id)) {
    return createResult(decision, SAFETY_STATUSES.REJECTED, false, 'VEHICLE_NOT_ELIGIBLE');
  }

  return null;
}

/**
 * Independently evaluates AI recommendations without changing simulation state.
 * The caller must pass the immutable snapshot used for the AI request and the
 * current live simulation state. Approved results are authorizations, not
 * movement commands.
 */
export function validateMovementProposals({
  proposal,
  snapshot,
  simulation,
  currentTickId,
  currentScenarioId,
  authorizedVehicleIds = [],
}) {
  const decisions = Array.isArray(proposal?.decisions) ? proposal.decisions : [];
  const decisionsWithTick = decisions.map((decision) => ({ ...decision, tickId: proposal?.tickId }));
  const proposalVehicleIds = decisions.map((decision) => decision?.vehicleId);
  const duplicateIds = new Set(proposalVehicleIds.filter((id, index) => id && proposalVehicleIds.indexOf(id) !== index));
  const currentEligibleIds = new Set(
    Array.isArray(simulation?.vehicles) ? getEligibleVehicles(simulation).map((vehicle) => vehicle.id) : [],
  );
  const snapshotEligibleIds = new Set(snapshot?.eligibleVehicleIds ?? []);
  const eligibilityMatches = hasSameIds(snapshot?.eligibleVehicleIds, [...currentEligibleIds]);
  const authorizedIds = new Set(authorizedVehicleIds);

  const results = decisionsWithTick.map((decision) => validateGoDecision({
    decision,
    snapshot,
    simulation,
    currentTickId,
    currentScenarioId,
    authorizedVehicleIds: authorizedIds,
    duplicateIds,
    currentEligibleIds,
    snapshotEligibleIds,
    eligibilityMatches,
  }));

  const occupancy = verifyOccupancy(snapshot, simulation);
  const candidates = results
    .map((result, index) => ({ result, index, decision: decisionsWithTick[index] }))
    .filter(({ result }) => result === null)
    .sort((first, second) => {
      const firstPriority = snapshot?.eligibleVehicleIds?.indexOf(first.decision.vehicleId) ?? -1;
      const secondPriority = snapshot?.eligibleVehicleIds?.indexOf(second.decision.vehicleId) ?? -1;
      return firstPriority - secondPriority || first.decision.vehicleId.localeCompare(second.decision.vehicleId);
    });

  const approvedMovements = [];
  candidates.forEach(({ index, decision }) => {
    if (!occupancy.valid) {
      results[index] = createResult(decision, SAFETY_STATUSES.REJECTED, false, 'OCCUPANCY_UNAVAILABLE');
      return;
    }

    const candidateVehicle = simulation.vehicles.find((vehicle) => vehicle.id === decision.vehicleId);
    if (!getMovementConflict(candidateVehicle, candidateVehicle).known) {
      results[index] = createResult(decision, SAFETY_STATUSES.REJECTED, false, 'MOVEMENT_GEOMETRY_UNAVAILABLE');
      return;
    }
    const crossingConflict = occupancy.crossingVehicles.map((crossingVehicle) => (
      getMovementConflict(candidateVehicle, crossingVehicle)
    ));
    if (crossingConflict.some((conflict) => !conflict.known)) {
      results[index] = createResult(decision, SAFETY_STATUSES.REJECTED, false, 'MOVEMENT_GEOMETRY_UNAVAILABLE');
      return;
    }
    if (crossingConflict.some((conflict) => conflict.conflicts)) {
      results[index] = createResult(decision, SAFETY_STATUSES.REJECTED, false, 'INTERSECTION_OCCUPIED');
      return;
    }

    const candidateConflicts = approvedMovements.map((approvedVehicle) => (
      getMovementConflict(candidateVehicle, approvedVehicle)
    ));
    if (candidateConflicts.some((conflict) => !conflict.known)) {
      results[index] = createResult(decision, SAFETY_STATUSES.REJECTED, false, 'MOVEMENT_GEOMETRY_UNAVAILABLE');
      return;
    }
    if (candidateConflicts.some((conflict) => conflict.conflicts)) {
      results[index] = createResult(decision, SAFETY_STATUSES.REJECTED, false, 'MOVEMENT_CONFLICT');
      return;
    }

    approvedMovements.push(candidateVehicle);
    results[index] = createResult(decision, SAFETY_STATUSES.APPROVED, true, 'ALL_SAFETY_CHECKS_PASSED');
  });

  const validation = {
    tickId: proposal?.tickId ?? null,
    scenarioId: snapshot?.scenarioId ?? null,
    results,
  };
  issuedSafetyValidations.set(validation, {
    proposal: JSON.parse(JSON.stringify(proposal ?? {})),
    snapshot: JSON.parse(JSON.stringify(snapshot ?? {})),
  });
  return validation;
}

// Execution consumes this private provenance record rather than trusting a
// caller-supplied `authorized: true` property on an arbitrary object.
export function getIssuedSafetyValidationContext(validation) {
  return issuedSafetyValidations.get(validation);
}
