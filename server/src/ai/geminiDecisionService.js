import { GoogleGenAI } from '@google/genai';
import {
  buildDecisionPrompt,
  buildSystemPrompt,
  buildTrafficSnapshot,
  validateTrafficSnapshot,
} from './promptBuilder.js';
import { DECISION_RESPONSE_SCHEMA, validateDecisionResponseShape } from './decisionSchema.js';

const DEFAULT_MODEL = 'gemini-3.8-flash';
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_CACHE_TTL_MS = 300_000;
const DEFAULT_CACHE_MAX_ENTRIES = 100;

export class GeminiDecisionError extends Error {
  constructor(code, message, httpStatus = 502) {
    super(message);
    this.name = 'GeminiDecisionError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/**
 * Creates the provider boundary for a single Gemini decision tick.
 * Dependencies are injectable so automated tests never contact Gemini.
 */
export function createGeminiDecisionService({
  environment = process.env,
  clientFactory = createGoogleGenAiClient,
  logger = console,
  now = () => Date.now(),
  cacheTtlMs = readPositiveInteger(environment.GEMINI_DECISION_CACHE_TTL_MS, DEFAULT_CACHE_TTL_MS),
  maxCacheEntries = DEFAULT_CACHE_MAX_ENTRIES,
} = {}) {
  const completedTicks = new Map();
  const inFlightTicks = new Map();

  async function requestDecision(snapshot) {
    const snapshotValidation = validateTrafficSnapshot(snapshot);
    if (!snapshotValidation.valid) {
      throw new GeminiDecisionError('INVALID_SNAPSHOT', 'Traffic snapshot is invalid.', 400);
    }

    const normalizedSnapshot = buildTrafficSnapshot(snapshot);
    const tickKey = `${normalizedSnapshot.scenarioId}:${normalizedSnapshot.tickId}`;
    const fingerprint = JSON.stringify(normalizedSnapshot);
    evictExpiredEntries();

    const cachedTick = completedTicks.get(tickKey);
    if (cachedTick) {
      ensureMatchingFingerprint(cachedTick.fingerprint, fingerprint);
      return { ...cachedTick.result, cached: true };
    }

    const pendingTick = inFlightTicks.get(tickKey);
    if (pendingTick) {
      ensureMatchingFingerprint(pendingTick.fingerprint, fingerprint);
      return pendingTick.promise;
    }

    const promise = generateDecision(normalizedSnapshot, fingerprint)
      .finally(() => inFlightTicks.delete(tickKey));
    inFlightTicks.set(tickKey, { fingerprint, promise });
    return promise;
  }

  async function generateDecision(normalizedSnapshot, fingerprint) {
    const configuration = readConfiguration(environment);
    const startedAt = now();
    const failures = [];

    for (const apiKey of configuration.apiKeys) {
      try {
        const client = clientFactory({ ...configuration, apiKey });
        const response = await client.models.generateContent({
          model: configuration.model,
          contents: buildDecisionPrompt(normalizedSnapshot),
          config: {
            systemInstruction: buildSystemPrompt(),
            responseMimeType: 'application/json',
            responseJsonSchema: createProviderDecisionSchema(),

            thinkingConfig: {
              thinkingLevel: 'low',
            },

            httpOptions: { timeout: configuration.timeoutMs },
          },
        });
        const decisionResponse = parseAndValidateModelResponse(extractResponseText(response), normalizedSnapshot);
        const result = {
          ...decisionResponse,
          model: configuration.model,
          latencyMs: Math.max(0, now() - startedAt),
          cached: false,
        };

        storeCompletedTick(`${normalizedSnapshot.scenarioId}:${normalizedSnapshot.tickId}`, fingerprint, result);
        return result;
      } catch (error) {
        failures.push({
          originalError: error,
          controlledError: error instanceof GeminiDecisionError ? error : mapProviderError(error),
        });
      }
    }

    const finalFailure = failures.at(-1);
    logSanitizedDiagnostic(logger, environment.NODE_ENV, finalFailure.originalError, finalFailure.controlledError, normalizedSnapshot, failures);
    throw finalFailure.controlledError;
  }

  function storeCompletedTick(tickKey, fingerprint, result) {
    while (completedTicks.size >= maxCacheEntries) {
      const oldestKey = completedTicks.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      completedTicks.delete(oldestKey);
    }

    completedTicks.set(tickKey, {
      fingerprint,
      result,
      expiresAt: now() + cacheTtlMs,
    });
  }

  function evictExpiredEntries() {
    const currentTime = now();
    for (const [tickKey, entry] of completedTicks) {
      if (entry.expiresAt <= currentTime) {
        completedTicks.delete(tickKey);
      }
    }
  }

  return {
    requestDecision,
    getCacheSize: () => completedTicks.size,
  };
}

export const geminiDecisionService = createGeminiDecisionService();

export function createProviderDecisionSchema() {
  return sanitizeSchemaForProvider(DECISION_RESPONSE_SCHEMA);
}

function createGoogleGenAiClient({ apiKey, timeoutMs }) {
  return new GoogleGenAI({
    apiKey,
    httpOptions: { timeout: timeoutMs },
  });
}

function readConfiguration(environment) {
  const apiKeys = [1, 2, 3, 4]
    .map((index) => environment[`GEMINI_API_KEY_${index}`]?.trim())
    .filter(Boolean);
  if (apiKeys.length === 0) {
    throw new GeminiDecisionError('MISSING_API_KEY', 'Gemini API is not configured.', 503);
  }

  const model = environment.GEMINI_MODEL?.trim() || DEFAULT_MODEL;
  if (!/^[A-Za-z0-9._-]+$/.test(model)) {
    throw new GeminiDecisionError('INVALID_MODEL_CONFIG', 'Gemini model configuration is invalid.', 503);
  }

  return {
    apiKeys,
    model,
    timeoutMs: readPositiveInteger(environment.GEMINI_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
  };
}

function parseAndValidateModelResponse(responseText, snapshot) {
  if (!responseText?.trim()) {
    throw new GeminiDecisionError('INVALID_MODEL_RESPONSE', 'Gemini returned an empty response.');
  }

  let parsedResponse;
  try {
    parsedResponse = JSON.parse(responseText);
  } catch {
    throw new GeminiDecisionError('INVALID_MODEL_RESPONSE', 'Gemini returned malformed JSON.');
  }

  const shapeValidation = validateDecisionResponseShape(parsedResponse);
  if (!shapeValidation.valid) {
    throw new GeminiDecisionError('INVALID_MODEL_RESPONSE', 'Gemini returned an invalid decision structure.');
  }

  if (parsedResponse.tickId !== snapshot.tickId) {
    throw new GeminiDecisionError('INVALID_MODEL_RESPONSE', 'Gemini returned a mismatched decision tick.');
  }

  const expectedVehicleIds = new Set(snapshot.eligibleVehicleIds);
  const returnedVehicleIds = parsedResponse.decisions.map((decision) => decision.vehicleId);
  const returnedVehicleIdSet = new Set(returnedVehicleIds);

  if (returnedVehicleIdSet.size !== returnedVehicleIds.length) {
    throw new GeminiDecisionError('INVALID_MODEL_RESPONSE', 'Gemini returned duplicate vehicle decisions.');
  }
  if (returnedVehicleIds.some((vehicleId) => !expectedVehicleIds.has(vehicleId))) {
    throw new GeminiDecisionError('INVALID_MODEL_RESPONSE', 'Gemini returned an unknown or ineligible vehicle decision.');
  }
  if (returnedVehicleIdSet.size !== expectedVehicleIds.size || [...expectedVehicleIds].some((vehicleId) => !returnedVehicleIdSet.has(vehicleId))) {
    throw new GeminiDecisionError('INVALID_MODEL_RESPONSE', 'Gemini did not return exactly one decision for every eligible vehicle.');
  }

  return {
    tickId: parsedResponse.tickId,
    decisions: parsedResponse.decisions.map(({ vehicleId, action, reasonCode }) => ({ vehicleId, action, reasonCode })),
  };
}

function extractResponseText(response) {
  if (typeof response?.text === 'string') {
    return response.text;
  }

  return response?.candidates?.[0]?.content?.parts
    ?.map((part) => part.text)
    .filter((text) => typeof text === 'string')
    .join('') ?? '';
}

function ensureMatchingFingerprint(existingFingerprint, incomingFingerprint) {
  if (existingFingerprint !== incomingFingerprint) {
    throw new GeminiDecisionError(
      'DUPLICATE_TICK_CONFLICT',
      'This tick ID was already submitted with a different traffic snapshot.',
      409,
    );
  }
}

function mapProviderError(error) {
  const { status, code, message } = getUpstreamErrorInfo(error);
  const normalizedMessage = message.toLowerCase();

  if (isAuthenticationFailure(status, code, normalizedMessage)) {
    return new GeminiDecisionError('GEMINI_AUTHENTICATION', 'Gemini authentication failed.', 401);
  }
  if (status === 403 || normalizedMessage.includes('permission denied') || normalizedMessage.includes('not authorized')) {
    return new GeminiDecisionError('GEMINI_PERMISSION_DENIED', 'Gemini access is not permitted for this project.', 403);
  }
  if (status === 404 || normalizedMessage.includes('model') && normalizedMessage.includes('not found')) {
    return new GeminiDecisionError('GEMINI_MODEL_NOT_FOUND', 'The configured Gemini model is unavailable.', 404);
  }
  if (status === 400 || normalizedMessage.includes('invalid argument') || normalizedMessage.includes('invalid request') || normalizedMessage.includes('schema')) {
    return new GeminiDecisionError('GEMINI_INVALID_REQUEST', 'Gemini rejected the decision request configuration.', 400);
  }
  if (status === 429 || normalizedMessage.includes('rate') || normalizedMessage.includes('quota')) {
    return new GeminiDecisionError('GEMINI_RATE_LIMITED', 'Gemini is temporarily rate limited.', 429);
  }
  if (status === 408 || status === 504 || normalizedMessage.includes('timeout') || normalizedMessage.includes('timed out') || error?.name === 'AbortError' || code === 'ETIMEDOUT') {
    return new GeminiDecisionError('GEMINI_TIMEOUT', 'Gemini request timed out.', 504);
  }
  if (isNetworkFailure(code, normalizedMessage)) {
    return new GeminiDecisionError('GEMINI_NETWORK_ERROR', 'Unable to reach Gemini.', 503);
  }
  return new GeminiDecisionError('GEMINI_UNAVAILABLE', 'Gemini is currently unavailable.', 503);
}

function sanitizeSchemaForProvider(schema) {
  if (Array.isArray(schema)) {
    return schema.map(sanitizeSchemaForProvider);
  }
  if (schema === null || typeof schema !== 'object') {
    return schema;
  }

  const supportedKeys = new Set([
    '$id', '$defs', '$ref', '$anchor', 'type', 'format', 'title', 'description',
    'enum', 'items', 'prefixItems', 'minItems', 'maxItems', 'minimum', 'maximum',
    'anyOf', 'oneOf', 'properties', 'additionalProperties', 'required', 'propertyOrdering',
  ]);

  return Object.fromEntries(Object.entries(schema)
    .filter(([key]) => supportedKeys.has(key))
    .map(([key, value]) => {
      if (key === 'properties' || key === '$defs') {
        return [key, Object.fromEntries(Object.entries(value).map(([propertyName, propertySchema]) => [
          propertyName,
          sanitizeSchemaForProvider(propertySchema),
        ]))];
      }
      return [key, sanitizeSchemaForProvider(value)];
    }));
}

function getUpstreamErrorInfo(error) {
  const statusCandidate = error?.status ?? error?.statusCode ?? error?.response?.status;
  const status = Number.isInteger(Number(statusCandidate)) ? Number(statusCandidate) : undefined;
  const rawCode = error?.code ?? error?.response?.data?.error?.code;

  return {
    name: typeof error?.name === 'string' ? error.name : 'UnknownError',
    status,
    code: rawCode === undefined || rawCode === null ? undefined : String(rawCode),
    message: sanitizeUpstreamMessage(error?.message),
  };
}

function isAuthenticationFailure(status, code, message) {
  return status === 401
    || code === 'UNAUTHENTICATED'
    || message.includes('api key not valid')
    || message.includes('invalid api key')
    || message.includes('authentication');
}

function isNetworkFailure(code, message) {
  return ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH'].includes(code)
    || message.includes('network')
    || message.includes('fetch failed')
    || message.includes('socket hang up');
}

function logSanitizedDiagnostic(logger, nodeEnvironment, originalError, controlledError, snapshot, failures = []) {
  if (nodeEnvironment === 'production') {
    return;
  }

  const upstream = originalError instanceof GeminiDecisionError
    ? undefined
    : getUpstreamErrorInfo(originalError);
  logger.warn?.('Gemini decision request failed.', {
    code: controlledError.code,
    tickId: snapshot.tickId,
    scenarioId: snapshot.scenarioId,
    ...(upstream ? {
      upstreamError: {
        name: upstream.name,
        status: upstream.status,
        code: upstream.code,
        message: upstream.message,
      },
    } : {}),
    ...(failures.length > 1 ? {
      attempts: failures.map(({ originalError: attemptError, controlledError: attemptControlledError }) => ({
        code: attemptControlledError.code,
        upstreamError: attemptError instanceof GeminiDecisionError ? undefined : getUpstreamErrorInfo(attemptError),
      })),
    } : {}),
  });
}

function sanitizeUpstreamMessage(value) {
  if (typeof value !== 'string') {
    return 'No upstream message was provided.';
  }

  return value
    .replace(/AIza[\w-]+/g, '[REDACTED_API_KEY]')
    .replace(/([?&](?:key|api[_-]?key|authorization)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]')
    .replace(/\s+/g, ' ')
    .slice(0, 300);
}

function readPositiveInteger(value, fallback) {
  if (value === undefined || value === '') {
    return fallback;
  }

  const parsedValue = Number(value);
  return Number.isInteger(parsedValue) && parsedValue > 0 ? parsedValue : fallback;
}
