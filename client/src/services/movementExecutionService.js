import { startApprovedVehicleMovements } from './simulationEngine.js';
import {
  getIssuedSafetyValidationContext,
  validateMovementProposals,
} from './safetyValidator.js';

export const MOVEMENT_EXECUTION_STATUSES = Object.freeze({
  STARTED: 'STARTED',
  NOT_EXECUTED: 'NOT_EXECUTED',
});

const executedValidationVehicles = new WeakMap();

function executionId(scenarioId, tickId, vehicleId) {
  return `${scenarioId}:${tickId}:${vehicleId}`;
}

function createExecutionResult(vehicleId, executionStatus, reason) {
  return { vehicleId, executionStatus, reason };
}

function getAuthorizedVehicleIds(executedAuthorizationIds, scenarioId, tickId) {
  const prefix = `${scenarioId}:${tickId}:`;
  return [...executedAuthorizationIds]
    .filter((id) => typeof id === 'string' && id.startsWith(prefix))
    .map((id) => id.slice(prefix.length));
}

/**
 * Starts only authorizations emitted by this module's Module 7 validator.
 * It revalidates the original proposal and snapshot against live state before
 * atomically committing the batch to the simulation engine.
 */
export function executeApprovedVehicleMovements(state, {
  safetyValidation,
  currentTickId,
  currentScenarioId,
  executedAuthorizationIds = [],
} = {}) {
  const authorizationContext = getIssuedSafetyValidationContext(safetyValidation);
  const suppliedResults = Array.isArray(safetyValidation?.results) ? safetyValidation.results : [];
  if (!authorizationContext) {
    return {
      state,
      results: suppliedResults.map((result) => (
        createExecutionResult(result.vehicleId, MOVEMENT_EXECUTION_STATUSES.NOT_EXECUTED, 'UNVERIFIED_AUTHORIZATION')
      )),
    };
  }

  const { proposal, snapshot } = authorizationContext;
  const contextMatches = safetyValidation.tickId === proposal.tickId
    && safetyValidation.scenarioId === snapshot.scenarioId
    && proposal.tickId === currentTickId
    && snapshot.scenarioId === currentScenarioId;
  if (!contextMatches) {
    const reason = proposal.tickId !== currentTickId ? 'STALE_TICK' : 'SCENARIO_MISMATCH';
    return {
      state,
      results: suppliedResults.map((result) => (
        createExecutionResult(result.vehicleId, MOVEMENT_EXECUTION_STATUSES.NOT_EXECUTED, reason)
      )),
    };
  }

  const executedIds = new Set(executedAuthorizationIds);
  const previouslyExecutedVehicleIds = new Set([
    ...getAuthorizedVehicleIds(executedIds, currentScenarioId, currentTickId),
    ...(executedValidationVehicles.get(safetyValidation) ?? []),
  ]);
  const revalidation = validateMovementProposals({
    proposal,
    snapshot,
    simulation: state,
    currentTickId,
    currentScenarioId,
    authorizedVehicleIds: previouslyExecutedVehicleIds,
  });
  const revalidatedByVehicleId = new Map(revalidation.results.map((result) => [result.vehicleId, result]));
  const results = [];
  const vehicleIdsToStart = [];

  suppliedResults.forEach((originalResult) => {
    const currentResult = revalidatedByVehicleId.get(originalResult.vehicleId);
    const id = executionId(currentScenarioId, currentTickId, originalResult.vehicleId);
    if (!originalResult.authorized) {
      results.push(createExecutionResult(originalResult.vehicleId, MOVEMENT_EXECUTION_STATUSES.NOT_EXECUTED, 'NOT_AUTHORIZED'));
    } else if (executedIds.has(id) || previouslyExecutedVehicleIds.has(originalResult.vehicleId)) {
      results.push(createExecutionResult(originalResult.vehicleId, MOVEMENT_EXECUTION_STATUSES.NOT_EXECUTED, 'ALREADY_EXECUTED'));
    } else if (!currentResult?.authorized) {
      results.push(createExecutionResult(
        originalResult.vehicleId,
        MOVEMENT_EXECUTION_STATUSES.NOT_EXECUTED,
        currentResult?.reason ?? 'AUTHORIZATION_INVALID',
      ));
    } else {
      vehicleIdsToStart.push(originalResult.vehicleId);
      results.push(createExecutionResult(originalResult.vehicleId, 'READY', 'READY_TO_START'));
    }
  });

  if (vehicleIdsToStart.length === 0) {
    return { state, results };
  }

  const movement = startApprovedVehicleMovements(state, vehicleIdsToStart);
  if (!movement.accepted) {
    return {
      state,
      results: results.map((result) => (
        result.executionStatus === 'READY'
          ? createExecutionResult(result.vehicleId, MOVEMENT_EXECUTION_STATUSES.NOT_EXECUTED, movement.reason)
          : result
      )),
    };
  }

  const startedVehicleIds = new Set(movement.startedVehicleIds);
  const executedForValidation = new Set(executedValidationVehicles.get(safetyValidation));
  startedVehicleIds.forEach((vehicleId) => executedForValidation.add(vehicleId));
  executedValidationVehicles.set(safetyValidation, executedForValidation);
  return {
    state: movement.state,
    results: results.map((result) => (
      startedVehicleIds.has(result.vehicleId)
        ? createExecutionResult(result.vehicleId, MOVEMENT_EXECUTION_STATUSES.STARTED, 'MOVEMENT_STARTED')
        : result
    )),
  };
}

export function getAuthorizationExecutionId(scenarioId, tickId, vehicleId) {
  return executionId(scenarioId, tickId, vehicleId);
}
