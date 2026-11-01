export const PROMPT_VERSION = 'traffic-coordination-v1';

const EXPECTED_VEHICLE_COUNT = 20;
const VEHICLE_DIRECTIONS = ['NORTH', 'SOUTH', 'EAST', 'WEST'];
const VEHICLE_ROUTES = ['LEFT', 'STRAIGHT', 'RIGHT'];
const VEHICLE_STATUSES = ['APPROACHING', 'WAITING', 'CROSSING', 'EXITED'];
const VEHICLE_FIELDS = [
  'id',
  'incomingDirection',
  'route',
  'status',
  'x',
  'y',
  'queuePosition',
  'waitingTime',
  'speed',
  'atStopLine',
];

/**
 * The snapshot contract retains EXITED vehicles. Keeping all twenty vehicles
 * gives every decision tick a stable, auditable scenario record.
 *
 * Queue-head eligibility remains authoritative in the simulation/application
 * layer. This module only confirms that each supplied eligible vehicle exists,
 * is WAITING, and is at its stop line; it does not recalculate queue order.
 */
export function validateTrafficSnapshot(snapshot, expectedVehicleCount = EXPECTED_VEHICLE_COUNT) {
  const errors = [];

  if (!isPlainObject(snapshot)) {
    return { valid: false, errors: ['Traffic snapshot must be an object.'] };
  }

  if (!isNonEmptyString(snapshot.tickId)) {
    errors.push('tickId must be a non-empty string.');
  }
  if (!isNonEmptyString(snapshot.scenarioId)) {
    errors.push('scenarioId must be a non-empty string.');
  }
  if (!isNonNegativeFiniteNumber(snapshot.simulationTimeSeconds)) {
    errors.push('simulationTimeSeconds must be a non-negative finite number.');
  }

  validateIntersection(snapshot.intersection, errors);
  const vehicleById = validateVehicles(snapshot.vehicles, expectedVehicleCount, errors);
  validateCrossingVehicles(snapshot.intersection, vehicleById, errors);
  validateEligibleVehicles(snapshot.eligibleVehicleIds, vehicleById, errors);

  return { valid: errors.length === 0, errors };
}

export function buildTrafficSnapshot(snapshot) {
  assertValidTrafficSnapshot(snapshot);

  return {
    tickId: snapshot.tickId,
    scenarioId: snapshot.scenarioId,
    simulationTimeSeconds: snapshot.simulationTimeSeconds,
    intersection: {
      id: snapshot.intersection.id,
      currentlyCrossingVehicleIds: [...snapshot.intersection.currentlyCrossingVehicleIds].sort(),
      occupancy: {
        known: snapshot.intersection.occupancy.known,
        occupiedZones: [...snapshot.intersection.occupancy.occupiedZones].sort(),
        dataSource: snapshot.intersection.occupancy.dataSource,
      },
      ...(snapshot.intersection.conflictInformation
        ? {
            conflictInformation: {
              available: snapshot.intersection.conflictInformation.available,
              source: snapshot.intersection.conflictInformation.source,
              compatibilityNotes: [...snapshot.intersection.conflictInformation.compatibilityNotes],
            },
          }
        : {}),
    },
    vehicles: snapshot.vehicles
      .map((vehicle) => Object.fromEntries(VEHICLE_FIELDS.map((field) => [field, vehicle[field]])))
      .sort((first, second) => first.id.localeCompare(second.id)),
    eligibleVehicleIds: [...snapshot.eligibleVehicleIds].sort(),
  };
}

export function buildSystemPrompt() {
  return `You are a traffic coordination decision assistant for a four-way autonomous-vehicle intersection.
Prompt version: ${PROMPT_VERSION}.

Your primary objective is to propose efficient, fair traffic coordination while prioritizing safety. Evaluate the complete traffic snapshot together: all vehicle states, incoming directions, intended routes, queue positions, waiting times, vehicles already crossing, occupancy data, and any supplied conflict information. Do not make isolated decisions without considering the entire intersection.

The application supplies the eligibleVehicleIds list. Never return GO or WAIT decisions for any vehicle outside that list. Never invent vehicle IDs, occupancy facts, conflict zones, or route compatibility. Consider vehicles already crossing and supplied occupied-zone information. Do not assume that different incoming directions or routes are non-conflicting, and do not claim that a proposed movement is guaranteed safe.

Your decisions are recommendations only. You do not have authority to authorize physical vehicle movement. A deterministic safety validator independently evaluates all GO proposals before execution.

Use waiting time, queue position, starvation risk, and repeated priority when considering fairness. Avoid repeatedly prioritizing one approach without a valid reason. Do not make random decisions. Seek throughput and avoid unnecessary waiting, and consider multiple compatible GO proposals only when the supplied information supports them. Never sacrifice safety for throughput. The current application may use temporary development restrictions; do not treat those as final traffic policy.

When information is incomplete or unavailable, do not invent facts. Be conservative and return WAIT where appropriate using an allowed reason code.

Return JSON only, with no Markdown fences or explanatory prose. Return exactly the input tickId. Include exactly one decision for every eligibleVehicleId and no decisions for other vehicles. Each decision must use action GO or WAIT and one allowed reasonCode: PRIORITY, FAIRNESS, WAITING_TIME, CONFLICT_CONCERN, OCCUPIED_INTERSECTION, or DEFERRED. Do not add unsupported fields. If no vehicles are eligible, return an empty decisions array.`;
}

export function buildDecisionPrompt(snapshot) {
  const normalizedSnapshot = buildTrafficSnapshot(snapshot);

  return `Traffic snapshot for decision tick:\n${JSON.stringify(normalizedSnapshot, null, 2)}\n\nReturn the decision JSON object for this tick.`;
}

function assertValidTrafficSnapshot(snapshot) {
  const validation = validateTrafficSnapshot(snapshot);

  if (!validation.valid) {
    throw new Error(`Traffic snapshot validation failed: ${validation.errors.join(' ')}`);
  }
}

function validateIntersection(intersection, errors) {
  if (!isPlainObject(intersection)) {
    errors.push('intersection must be an object.');
    return;
  }
  if (!isNonEmptyString(intersection.id)) {
    errors.push('intersection.id must be a non-empty string.');
  }
  if (!Array.isArray(intersection.currentlyCrossingVehicleIds)) {
    errors.push('intersection.currentlyCrossingVehicleIds must be an array.');
  }

  const { occupancy } = intersection;
  if (!isPlainObject(occupancy)) {
    errors.push('intersection.occupancy must be an object.');
    return;
  }
  if (typeof occupancy.known !== 'boolean') {
    errors.push('intersection.occupancy.known must be a boolean.');
  }
  if (!Array.isArray(occupancy.occupiedZones)) {
    errors.push('intersection.occupancy.occupiedZones must be an array.');
  }
  if (!isNonEmptyString(occupancy.dataSource)) {
    errors.push('intersection.occupancy.dataSource must state the source or unavailability.');
  }

  if (intersection.conflictInformation !== undefined) {
    const { conflictInformation } = intersection;
    if (!isPlainObject(conflictInformation)) {
      errors.push('intersection.conflictInformation must be an object when supplied.');
    } else {
      if (typeof conflictInformation.available !== 'boolean') {
        errors.push('intersection.conflictInformation.available must be a boolean.');
      }
      if (!isNonEmptyString(conflictInformation.source)) {
        errors.push('intersection.conflictInformation.source must be a non-empty string.');
      }
      if (!Array.isArray(conflictInformation.compatibilityNotes) || !conflictInformation.compatibilityNotes.every(isNonEmptyString)) {
        errors.push('intersection.conflictInformation.compatibilityNotes must be an array of non-empty strings.');
      }
    }
  }
}

function validateVehicles(vehicles, expectedVehicleCount, errors) {
  const vehicleById = new Map();

  if (!Array.isArray(vehicles)) {
    errors.push('vehicles must be an array.');
    return vehicleById;
  }
  if (vehicles.length !== expectedVehicleCount) {
    errors.push(`vehicles must contain exactly ${expectedVehicleCount} vehicles.`);
  }

  vehicles.forEach((vehicle, index) => {
    if (!isPlainObject(vehicle)) {
      errors.push(`vehicles[${index}] must be an object.`);
      return;
    }

    VEHICLE_FIELDS.forEach((field) => {
      if (!(field in vehicle)) {
        errors.push(`vehicles[${index}].${field} is required.`);
      }
    });
    if (!isNonEmptyString(vehicle.id)) {
      errors.push(`vehicles[${index}].id must be a non-empty string.`);
    } else if (vehicleById.has(vehicle.id)) {
      errors.push(`Vehicle ID ${vehicle.id} is duplicated.`);
    } else {
      vehicleById.set(vehicle.id, vehicle);
    }
    if (!VEHICLE_DIRECTIONS.includes(vehicle.incomingDirection)) {
      errors.push(`vehicles[${index}].incomingDirection is invalid.`);
    }
    if (!VEHICLE_ROUTES.includes(vehicle.route)) {
      errors.push(`vehicles[${index}].route is invalid.`);
    }
    if (!VEHICLE_STATUSES.includes(vehicle.status)) {
      errors.push(`vehicles[${index}].status is invalid.`);
    }
    if (!isFiniteNumber(vehicle.x) || !isFiniteNumber(vehicle.y)) {
      errors.push(`vehicles[${index}].x and y must be finite numbers.`);
    }
    if (!Number.isInteger(vehicle.queuePosition) || vehicle.queuePosition < 0) {
      errors.push(`vehicles[${index}].queuePosition must be a non-negative integer.`);
    }
    if (!isNonNegativeFiniteNumber(vehicle.waitingTime)) {
      errors.push(`vehicles[${index}].waitingTime must be a non-negative finite number.`);
    }
    if (!isNonNegativeFiniteNumber(vehicle.speed)) {
      errors.push(`vehicles[${index}].speed must be a non-negative finite number.`);
    }
    if (typeof vehicle.atStopLine !== 'boolean') {
      errors.push(`vehicles[${index}].atStopLine must be a boolean.`);
    }
  });

  return vehicleById;
}

function validateCrossingVehicles(intersection, vehicleById, errors) {
  if (!isPlainObject(intersection) || !Array.isArray(intersection.currentlyCrossingVehicleIds)) {
    return;
  }

  const crossingIds = intersection.currentlyCrossingVehicleIds;
  if (new Set(crossingIds).size !== crossingIds.length) {
    errors.push('intersection.currentlyCrossingVehicleIds must not contain duplicates.');
  }
  const actualCrossingIds = [...vehicleById.values()]
    .filter((vehicle) => vehicle.status === 'CROSSING')
    .map((vehicle) => vehicle.id)
    .sort();

  crossingIds.forEach((vehicleId) => {
    const vehicle = vehicleById.get(vehicleId);
    if (!vehicle) {
      errors.push(`Crossing vehicle ${vehicleId} does not exist.`);
    } else if (vehicle.status !== 'CROSSING') {
      errors.push(`Crossing vehicle ${vehicleId} must have CROSSING status.`);
    }
  });
  if (JSON.stringify([...crossingIds].sort()) !== JSON.stringify(actualCrossingIds)) {
    errors.push('currentlyCrossingVehicleIds must exactly match vehicles in CROSSING state.');
  }
}

function validateEligibleVehicles(eligibleVehicleIds, vehicleById, errors) {
  if (!Array.isArray(eligibleVehicleIds)) {
    errors.push('eligibleVehicleIds must be an array.');
    return;
  }
  if (new Set(eligibleVehicleIds).size !== eligibleVehicleIds.length) {
    errors.push('eligibleVehicleIds must not contain duplicates.');
  }

  eligibleVehicleIds.forEach((vehicleId) => {
    const vehicle = vehicleById.get(vehicleId);
    if (!vehicle) {
      errors.push(`Eligible vehicle ${vehicleId} does not exist.`);
    } else if (vehicle.status !== 'WAITING' || vehicle.atStopLine !== true) {
      errors.push(`Eligible vehicle ${vehicleId} must be WAITING at the stop line.`);
    }
  });
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegativeFiniteNumber(value) {
  return isFiniteNumber(value) && value >= 0;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}
