export const DECISION_ACTIONS = Object.freeze(['GO', 'WAIT']);
export const DECISION_REASON_CODES = Object.freeze([
  'PRIORITY',
  'FAIRNESS',
  'WAITING_TIME',
  'CONFLICT_CONCERN',
  'OCCUPIED_INTERSECTION',
  'DEFERRED',
]);

/**
 * Provider-independent JSON Schema for the model response.
 *
 * JSON Schema verifies response shape and enum values only. Module 6/7 must
 * additionally verify the tick ID and exact eligible-vehicle coverage before
 * any proposal reaches the safety validator.
 */
export const DECISION_RESPONSE_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'traffic-coordination-decision-v1',
  title: 'Traffic coordination proposal',
  type: 'object',
  additionalProperties: false,
  required: ['tickId', 'decisions'],
  properties: {
    tickId: {
      type: 'string',
      minLength: 1,
    },
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['vehicleId', 'action', 'reasonCode'],
        properties: {
          vehicleId: { type: 'string', minLength: 1 },
          action: { type: 'string', enum: DECISION_ACTIONS },
          reasonCode: { type: 'string', enum: DECISION_REASON_CODES },
        },
      },
    },
  },
});

/**
 * Lightweight structural validation for local fixtures and provider responses.
 * Relationship validation (tick equality, unknown/duplicate/missing decisions)
 * intentionally belongs to the Module 6/7 runtime validation boundary.
 */
export function validateDecisionResponseShape(response) {
  const errors = [];

  if (!isPlainObject(response)) {
    return { valid: false, errors: ['Response must be an object.'] };
  }

  const responseKeys = Object.keys(response);
  const unsupportedKeys = responseKeys.filter((key) => !['tickId', 'decisions'].includes(key));
  if (unsupportedKeys.length > 0) {
    errors.push(`Unsupported response fields: ${unsupportedKeys.join(', ')}.`);
  }

  if (!isNonEmptyString(response.tickId)) {
    errors.push('tickId must be a non-empty string.');
  }

  if (!Array.isArray(response.decisions)) {
    errors.push('decisions must be an array.');
  } else {
    response.decisions.forEach((decision, index) => {
      if (!isPlainObject(decision)) {
        errors.push(`decisions[${index}] must be an object.`);
        return;
      }

      const unsupportedDecisionKeys = Object.keys(decision)
        .filter((key) => !['vehicleId', 'action', 'reasonCode'].includes(key));
      if (unsupportedDecisionKeys.length > 0) {
        errors.push(`decisions[${index}] has unsupported fields: ${unsupportedDecisionKeys.join(', ')}.`);
      }
      if (!isNonEmptyString(decision.vehicleId)) {
        errors.push(`decisions[${index}].vehicleId must be a non-empty string.`);
      }
      if (!DECISION_ACTIONS.includes(decision.action)) {
        errors.push(`decisions[${index}].action must be GO or WAIT.`);
      }
      if (!DECISION_REASON_CODES.includes(decision.reasonCode)) {
        errors.push(`decisions[${index}].reasonCode is not supported.`);
      }
    });
  }

  return { valid: errors.length === 0, errors };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}
