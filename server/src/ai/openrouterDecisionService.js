import {
  buildDecisionPrompt,
  buildSystemPrompt,
  buildTrafficSnapshot,
  validateTrafficSnapshot,
} from './promptBuilder.js';
import {
  DECISION_ACTIONS,
  DECISION_REASON_CODES,
  validateDecisionResponseShape,
} from './decisionSchema.js';

const DEFAULT_MODEL = 'nvidia/nemotron-3.5-lightning:free';
const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_TIMEOUT_MS = 40_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_MAX_TOKENS = 1_024;
const DEFAULT_CACHE_TTL_MS = 300_000;
const DEFAULT_CACHE_MAX_ENTRIES = 100;

export class OpenRouterDecisionError extends Error {
  constructor(code, message, httpStatus = 502) {
    super(message);
    this.name = 'OpenRouterDecisionError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/**
 * OpenRouter Chat Completions boundary. Dependencies are injected so tests do
 * not contact OpenRouter or consume model credits.
 */
export function createOpenRouterDecisionService({
  environment = process.env,
  fetchImplementation = fetch,
  logger = console,
  now = () => Date.now(),
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  random = Math.random,
  cacheTtlMs = readPositiveInteger(environment.OPENROUTER_DECISION_CACHE_TTL_MS, DEFAULT_CACHE_TTL_MS),
  maxCacheEntries = DEFAULT_CACHE_MAX_ENTRIES,
} = {}) {
  const completedTicks = new Map();
  const inFlightTicks = new Map();

  async function requestDecision(snapshot) {
    const snapshotValidation = validateTrafficSnapshot(snapshot);
    if (!snapshotValidation.valid) {
      throw new OpenRouterDecisionError('INVALID_SNAPSHOT', 'Traffic snapshot is invalid.', 400);
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
    const request = createChatCompletionRequest(configuration, normalizedSnapshot);

    for (let attempt = 0; attempt <= configuration.maxRetries; attempt += 1) {
      try {
        const response = await sendChatCompletion(fetchImplementation, configuration, request);
        const decisionResponse = parseAndValidateModelResponse(
          extractJsonResponseContent(response.payload, response.diagnostics),
          normalizedSnapshot,
          response.diagnostics,
        );
        const result = {
          ...decisionResponse,
          scenarioId: normalizedSnapshot.scenarioId,
          provider: 'OpenRouter',
          model: configuration.model,
          latencyMs: Math.max(0, now() - startedAt),
          cached: false,
        };

        logDevelopmentDecisionAudit(logger, environment.NODE_ENV, normalizedSnapshot, decisionResponse, response.diagnostics);
        storeCompletedTick(`${normalizedSnapshot.scenarioId}:${normalizedSnapshot.tickId}`, fingerprint, result);
        return result;
      } catch (error) {
        const controlledError = error instanceof OpenRouterDecisionError ? error : mapProviderError(error);
        failures.push({ originalError: error, controlledError });
        if (!isTransientError(controlledError) || attempt === configuration.maxRetries) {
          logSanitizedDiagnostic(logger, environment.NODE_ENV, error, controlledError, normalizedSnapshot, failures);
          throw controlledError;
        }

        await sleep(getRetryDelayMilliseconds(error, attempt, random));
      }
    }

    throw new OpenRouterDecisionError('OPENROUTER_UNAVAILABLE', 'OpenRouter is currently unavailable.', 503);
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

function logDevelopmentDecisionAudit(logger, nodeEnvironment, snapshot, decisionResponse, diagnostics) {
  if (nodeEnvironment !== 'development') {
    return;
  }

  const vehicleById = new Map(snapshot.vehicles.map((vehicle) => [vehicle.id, vehicle]));
  const eligibleVehicles = snapshot.eligibleVehicleIds.map((vehicleId) => {
    const vehicle = vehicleById.get(vehicleId);
    return {
      vehicleId,
      incomingDirection: vehicle?.incomingDirection,
      route: vehicle?.route,
      waitingTime: vehicle?.waitingTime,
      position: { x: vehicle?.x, y: vehicle?.y },
      status: vehicle?.status,
      atStopLine: vehicle?.atStopLine,
      queuePosition: vehicle?.queuePosition,
    };
  });
  const decisions = decisionResponse.decisions.map(({ vehicleId, action, reasonCode }) => ({ vehicleId, action, reasonCode }));

  logger.info?.('OpenRouter traffic decision audit.', {
    tickId: snapshot.tickId,
    scenarioId: snapshot.scenarioId,
    eligibleVehicles,
    currentlyCrossingVehicleIds: snapshot.intersection.currentlyCrossingVehicleIds,
    occupancy: snapshot.intersection.occupancy,
    conflictInformation: snapshot.intersection.conflictInformation
      ? {
          available: snapshot.intersection.conflictInformation.available,
          source: snapshot.intersection.conflictInformation.source,
          compatibilityNotes: snapshot.intersection.conflictInformation.compatibilityNotes,
        }
      : { available: false },
    decisions,
    decisionSummary: {
      goCount: decisions.filter((decision) => decision.action === 'GO').length,
      waitCount: decisions.filter((decision) => decision.action === 'WAIT').length,
    },
    responseMetadata: diagnostics,
  });
}

export const openRouterDecisionService = createOpenRouterDecisionService();

function readConfiguration(environment) {
  const apiKey = environment.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    throw new OpenRouterDecisionError('MISSING_API_KEY', 'OpenRouter API is not configured.', 503);
  }

  const model = environment.OPENROUTER_MODEL?.trim() || DEFAULT_MODEL;
  if (!/^[A-Za-z0-9._:/-]+$/.test(model)) {
    throw new OpenRouterDecisionError('INVALID_MODEL_CONFIG', 'OpenRouter model configuration is invalid.', 503);
  }

  const baseUrl = (environment.OPENROUTER_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
  try {
    const parsedUrl = new URL(baseUrl);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      throw new Error('Invalid protocol');
    }
  } catch {
    throw new OpenRouterDecisionError('INVALID_BASE_URL_CONFIG', 'OpenRouter base URL configuration is invalid.', 503);
  }

  return {
    apiKey,
    model,
    baseUrl,
    timeoutMs: readPositiveInteger(environment.OPENROUTER_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    maxRetries: readBoundedInteger(environment.OPENROUTER_MAX_RETRIES, DEFAULT_MAX_RETRIES, 0, 3),
    maxTokens: readBoundedInteger(environment.OPENROUTER_MAX_TOKENS, DEFAULT_MAX_TOKENS, 64, 4_096),
    httpReferer: environment.OPENROUTER_HTTP_REFERER?.trim(),
  };
}

function createChatCompletionRequest(configuration, snapshot) {
  const headers = {
    Authorization: `Bearer ${configuration.apiKey}`,
    'Content-Type': 'application/json',
    'X-Title': 'MiniMol',
  };
  if (configuration.httpReferer) {
    headers['HTTP-Referer'] = configuration.httpReferer;
  }

  return {
    url: `${configuration.baseUrl}/chat/completions`,
    headers,
    body: {
      model: configuration.model,
      messages: [
        { role: 'system', content: buildSystemPrompt() },
        { role: 'user', content: buildDecisionPrompt(snapshot) },
      ],
      temperature: 0.1,
      max_tokens: configuration.maxTokens,
      stream: false,
      reasoning_effort: 'none',
    },
  };
}

async function sendChatCompletion(fetchImplementation, configuration, request) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), configuration.timeoutMs);
  try {
    const response = await fetchImplementation(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: controller.signal,
    });
    const payload = await readResponsePayload(response);
    const diagnostics = createResponseDiagnostics(payload, response.status);
    if (!response.ok) {
      const error = new Error(payload?.error?.message || payload?.message || `OpenRouter request failed with status ${response.status}.`);
      error.status = response.status;
      error.code = payload?.error?.code;
      error.retryAfter = readHeader(response.headers, 'retry-after');
      error.responseDiagnostics = diagnostics;
      throw error;
    }
    if (payload?.error) {
      throw createResponseError(
        'OPENROUTER_PROVIDER_ERROR',
        'OpenRouter returned an upstream provider error.',
        502,
        diagnostics,
      );
    }
    return { payload, diagnostics };
  } catch (error) {
    if (controller.signal.aborted) {
      const timeoutError = new Error('OpenRouter request timed out.');
      timeoutError.name = 'AbortError';
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function readResponsePayload(response) {
  try {
    if (typeof response?.text === 'function') {
      const text = await response.text();
      return text ? JSON.parse(text) : {};
    }
    if (typeof response?.json === 'function') {
      return await response.json();
    }
  } catch {
    throw new OpenRouterDecisionError('OPENROUTER_INVALID_RESPONSE', 'OpenRouter returned an invalid API response.', 502);
  }
  throw new OpenRouterDecisionError('OPENROUTER_INVALID_RESPONSE', 'OpenRouter returned an invalid API response.', 502);
}

function createResponseDiagnostics(payload, httpStatus) {
  const choices = Array.isArray(payload?.choices) ? payload.choices : null;
  const choice = choices?.[0];
  const message = choice?.message;
  const usage = payload?.usage;
  const reasoningDetails = message?.reasoning_details;
  const reasoningTokens = usage?.completion_tokens_details?.reasoning_tokens;

  return {
    httpStatus: Number.isInteger(httpStatus) ? httpStatus : null,
    hasTopLevelError: Boolean(payload?.error),
    topLevelErrorCode: sanitizeDiagnosticValue(payload?.error?.code),
    choicesPresent: Array.isArray(payload?.choices),
    choiceCount: choices?.length ?? 0,
    messagePresent: Boolean(message && typeof message === 'object'),
    contentPresent: typeof message?.content === 'string' && message.content.trim().length > 0,
    contentLength: typeof message?.content === 'string' ? message.content.length : 0,
    reasoningPresent: typeof message?.reasoning === 'string' && message.reasoning.length > 0,
    reasoningDetailsPresent: Array.isArray(reasoningDetails) ? reasoningDetails.length > 0 : Boolean(reasoningDetails),
    finishReason: sanitizeDiagnosticValue(choice?.finish_reason),
    nativeFinishReason: sanitizeDiagnosticValue(choice?.native_finish_reason ?? payload?.native_finish_reason),
    promptTokens: numberOrNull(usage?.prompt_tokens),
    completionTokens: numberOrNull(usage?.completion_tokens),
    reasoningTokens: numberOrNull(reasoningTokens),
    returnedModel: sanitizeDiagnosticValue(payload?.model),
    provider: sanitizeDiagnosticValue(
      payload?.provider
        ?? payload?.openrouter_metadata?.provider_name
        ?? payload?.openrouter_metadata?.provider,
    ),
  };
}

function numberOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function sanitizeDiagnosticValue(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').slice(0, 120) : null;
}

function extractJsonResponseContent(response, diagnostics) {
  const content = response?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    if (diagnostics.finishReason === 'length') {
      const reasoningTokens = diagnostics.reasoningTokens ?? 0;
      return throwResponseError(
        reasoningTokens > 0 ? 'OPENROUTER_REASONING_TOKEN_EXHAUSTED' : 'OPENROUTER_OUTPUT_TRUNCATED',
        reasoningTokens > 0
          ? 'OpenRouter exhausted its response budget on reasoning before producing a decision.'
          : 'OpenRouter stopped before producing a complete decision response.',
        diagnostics,
      );
    }
    return throwResponseError(
      'OPENROUTER_EMPTY_MODEL_RESPONSE',
      'OpenRouter returned an empty decision response.',
      diagnostics,
    );
  }

  const trimmedContent = content.trim();
  const fencedMatch = trimmedContent.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fencedMatch) {
    return fencedMatch[1].trim();
  }

  const firstBrace = trimmedContent.indexOf('{');
  if (firstBrace === -1) {
    return trimmedContent;
  }
  const jsonObject = findBalancedJsonObject(trimmedContent, firstBrace);
  return jsonObject ?? trimmedContent;
}

function throwResponseError(code, message, diagnostics) {
  throw createResponseError(code, message, 502, diagnostics);
}

function createResponseError(code, message, httpStatus, diagnostics, validationDiagnostics) {
  const error = new OpenRouterDecisionError(code, message, httpStatus);
  error.responseDiagnostics = diagnostics;
  if (validationDiagnostics) {
    error.validationDiagnostics = validationDiagnostics;
  }
  return error;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function findBalancedJsonObject(value, startIndex) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = startIndex; index < value.length; index += 1) {
    const character = value[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        return value.slice(startIndex, index + 1);
      }
    }
  }
  return null;
}

function parseAndValidateModelResponse(responseText, snapshot, diagnostics) {
  let parsedResponse;
  try {
    parsedResponse = JSON.parse(responseText);
  } catch {
    throw createResponseError('OPENROUTER_MALFORMED_DECISION_JSON', 'OpenRouter returned malformed decision JSON.', 502, diagnostics);
  }

  const normalizedResponse = normalizeUnambiguousDecisionMap(parsedResponse);
  const shapeValidation = validateDecisionResponseShape(normalizedResponse);
  const validationDiagnostics = createDecisionValidationDiagnostics(normalizedResponse, snapshot, shapeValidation.errors);
  if (!shapeValidation.valid) {
    throw createResponseError(
      'OPENROUTER_INVALID_DECISION_SCHEMA',
      'OpenRouter returned an invalid decision structure.',
      502,
      diagnostics,
      validationDiagnostics,
    );
  }
  if (normalizedResponse.tickId !== snapshot.tickId) {
    throw createResponseError(
      'OPENROUTER_MISMATCHED_DECISION_TICK',
      'OpenRouter returned a mismatched decision tick.',
      502,
      diagnostics,
      validationDiagnostics,
    );
  }

  const expectedVehicleIds = new Set(snapshot.eligibleVehicleIds);
  const returnedVehicleIds = normalizedResponse.decisions.map((decision) => decision.vehicleId);
  const returnedVehicleIdSet = new Set(returnedVehicleIds);
  if (returnedVehicleIdSet.size !== returnedVehicleIds.length) {
    throw createResponseError(
      'OPENROUTER_INVALID_DECISION_COVERAGE',
      'OpenRouter returned duplicate vehicle decisions.',
      502,
      diagnostics,
      validationDiagnostics,
    );
  }
  if (returnedVehicleIds.some((vehicleId) => !expectedVehicleIds.has(vehicleId))) {
    throw createResponseError(
      'OPENROUTER_INVALID_DECISION_COVERAGE',
      'OpenRouter returned an unknown or ineligible vehicle decision.',
      502,
      diagnostics,
      validationDiagnostics,
    );
  }
  if (returnedVehicleIdSet.size !== expectedVehicleIds.size
    || [...expectedVehicleIds].some((vehicleId) => !returnedVehicleIdSet.has(vehicleId))) {
    throw createResponseError(
      'OPENROUTER_INVALID_DECISION_COVERAGE',
      'OpenRouter did not return exactly one decision for every eligible vehicle.',
      502,
      diagnostics,
      validationDiagnostics,
    );
  }

  return {
    tickId: normalizedResponse.tickId,
    decisions: normalizedResponse.decisions.map(({ vehicleId, action, reasonCode }) => ({ vehicleId, action, reasonCode })),
  };
}

/**
 * Some non-constrained models return an object map such as
 * { "V001": { "action": "GO", "reasonCode": "PRIORITY" } } instead of
 * the requested array. A map key is an unambiguous vehicle ID, so preserve
 * every value and let the existing strict schema and coverage checks validate
 * the result. Any conflicting embedded ID or non-object map value is left
 * untouched and rejected by the normal validation path.
 */
function normalizeUnambiguousDecisionMap(response) {
  if (!isPlainObject(response) || !isPlainObject(response.decisions)) {
    return response;
  }

  const entries = Object.entries(response.decisions);
  if (entries.some(([vehicleId, decision]) => (
    !isNonEmptyString(vehicleId)
    || !isPlainObject(decision)
    || ('vehicleId' in decision && decision.vehicleId !== vehicleId)
  ))) {
    return response;
  }

  return {
    ...response,
    decisions: entries.map(([vehicleId, decision]) => ({ vehicleId, ...decision })),
  };
}

function createDecisionValidationDiagnostics(response, snapshot, failedRules = []) {
  const responseIsObject = isPlainObject(response);
  const decisions = responseIsObject && Array.isArray(response.decisions) ? response.decisions : [];
  const returnedVehicleIds = decisions
    .filter((decision) => isPlainObject(decision) && typeof decision.vehicleId === 'string')
    .map((decision) => decision.vehicleId);
  const expectedVehicleIds = [...snapshot.eligibleVehicleIds];
  const returnedVehicleIdSet = new Set(returnedVehicleIds);

  return {
    failedRules: failedRules.map((rule) => sanitizeDiagnosticValue(rule)),
    expectedStructure: {
      requiredTopLevelFields: ['tickId', 'decisions'],
      allowedTopLevelFields: ['tickId', 'decisions'],
      requiredDecisionFields: ['vehicleId', 'action', 'reasonCode'],
      allowedDecisionFields: ['vehicleId', 'action', 'reasonCode'],
      allowedActions: [...DECISION_ACTIONS],
      allowedReasonCodes: [...DECISION_REASON_CODES],
    },
    actualStructure: {
      topLevelType: describeValueType(response),
      topLevelFieldNames: responseIsObject ? sanitizeFieldNames(Object.keys(response)) : [],
      tickIdType: responseIsObject ? describeValueType(response.tickId) : null,
      decisionsType: responseIsObject ? describeValueType(response.decisions) : null,
      decisionCount: Array.isArray(response?.decisions) ? response.decisions.length : null,
      decisions: decisions.slice(0, 20).map((decision, index) => describeDecisionStructure(decision, index)),
    },
    vehicleCoverage: {
      expectedVehicleIds,
      returnedVehicleIds: returnedVehicleIds.map(sanitizeVehicleId),
      missingVehicleIds: expectedVehicleIds.filter((vehicleId) => !returnedVehicleIdSet.has(vehicleId)),
      extraVehicleIds: returnedVehicleIds
        .filter((vehicleId) => !expectedVehicleIds.includes(vehicleId))
        .map(sanitizeVehicleId),
      duplicateVehicleIds: [...returnedVehicleIdSet]
        .filter((vehicleId) => returnedVehicleIds.filter((id) => id === vehicleId).length > 1)
        .map(sanitizeVehicleId),
    },
  };
}

function describeDecisionStructure(decision, index) {
  if (!isPlainObject(decision)) {
    return { index, type: describeValueType(decision) };
  }

  const fields = Object.keys(decision);
  const action = decision.action;
  const reasonCode = decision.reasonCode;
  return {
    index,
    type: 'object',
    fieldNames: sanitizeFieldNames(fields),
    missingFields: ['vehicleId', 'action', 'reasonCode'].filter((field) => !(field in decision)),
    extraFields: sanitizeFieldNames(fields.filter((field) => !['vehicleId', 'action', 'reasonCode'].includes(field))),
    vehicleId: typeof decision.vehicleId === 'string' ? sanitizeVehicleId(decision.vehicleId) : null,
    invalidAction: DECISION_ACTIONS.includes(action) ? null : sanitizeEnumValue(action),
    invalidReasonCode: DECISION_REASON_CODES.includes(reasonCode) ? null : sanitizeEnumValue(reasonCode),
  };
}

function describeValueType(value) {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value;
}

function sanitizeFieldNames(fields) {
  return fields.slice(0, 20).map((field) => (
    /(?:authorization|api[_-]?key|token|secret)/i.test(field)
      ? '[REDACTED_FIELD]'
      : field.slice(0, 80)
  ));
}

function sanitizeVehicleId(vehicleId) {
  return /^[A-Za-z0-9_-]{1,64}$/.test(vehicleId) ? vehicleId : '[INVALID_VEHICLE_ID]';
}

function sanitizeEnumValue(value) {
  if (typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value)) {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return String(value);
  }
  return `[${describeValueType(value)}]`;
}

function ensureMatchingFingerprint(existingFingerprint, incomingFingerprint) {
  if (existingFingerprint !== incomingFingerprint) {
    throw new OpenRouterDecisionError(
      'DUPLICATE_TICK_CONFLICT',
      'This tick ID was already submitted with a different traffic snapshot.',
      409,
    );
  }
}

function isTransientError(error) {
  return ['OPENROUTER_RATE_LIMITED', 'OPENROUTER_TIMEOUT', 'OPENROUTER_NETWORK_ERROR', 'OPENROUTER_UNAVAILABLE'].includes(error.code);
}

function getRetryDelayMilliseconds(error, attempt, random) {
  const retryAfterMilliseconds = parseRetryAfter(error?.retryAfter);
  if (retryAfterMilliseconds !== undefined) {
    return retryAfterMilliseconds;
  }
  return Math.min(5_000, 500 * (2 ** attempt)) + Math.floor(random() * 250);
}

function parseRetryAfter(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1_000);
  }
  const dateMilliseconds = Date.parse(value);
  return Number.isNaN(dateMilliseconds) ? undefined : Math.max(0, dateMilliseconds - Date.now());
}

function mapProviderError(error) {
  const { status, code, message } = getUpstreamErrorInfo(error);
  const normalizedMessage = message.toLowerCase();

  if (status === 401 || code === 'UNAUTHORIZED' || normalizedMessage.includes('invalid api key') || normalizedMessage.includes('authentication')) {
    return new OpenRouterDecisionError('OPENROUTER_AUTHENTICATION', 'OpenRouter authentication failed.', 401);
  }
  if (status === 402 || normalizedMessage.includes('insufficient credits') || normalizedMessage.includes('payment required')) {
    return new OpenRouterDecisionError('OPENROUTER_INSUFFICIENT_CREDITS', 'OpenRouter account credits are unavailable.', 402);
  }
  if (status === 403 || normalizedMessage.includes('permission denied') || normalizedMessage.includes('not authorized')) {
    return new OpenRouterDecisionError('OPENROUTER_PERMISSION_DENIED', 'OpenRouter access is not permitted.', 403);
  }
  if (status === 404 || normalizedMessage.includes('model') && normalizedMessage.includes('not found')) {
    return new OpenRouterDecisionError('OPENROUTER_MODEL_NOT_FOUND', 'The configured OpenRouter model is unavailable.', 404);
  }
  if (status === 400 || status === 422 || normalizedMessage.includes('invalid request') || normalizedMessage.includes('invalid argument')) {
    return new OpenRouterDecisionError('OPENROUTER_INVALID_REQUEST', 'OpenRouter rejected the decision request.', 400);
  }
  if (status === 429 || normalizedMessage.includes('rate limit') || normalizedMessage.includes('too many requests')) {
    return new OpenRouterDecisionError('OPENROUTER_RATE_LIMITED', 'OpenRouter is temporarily rate limited.', 429);
  }
  if (status === 408 || status === 504 || normalizedMessage.includes('timed out') || normalizedMessage.includes('timeout') || error?.name === 'AbortError' || code === 'ETIMEDOUT') {
    return new OpenRouterDecisionError('OPENROUTER_TIMEOUT', 'OpenRouter request timed out.', 504);
  }
  if (isNetworkFailure(code, normalizedMessage)) {
    return new OpenRouterDecisionError('OPENROUTER_NETWORK_ERROR', 'Unable to reach OpenRouter.', 503);
  }
  return new OpenRouterDecisionError('OPENROUTER_UNAVAILABLE', 'OpenRouter is currently unavailable.', 503);
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

function isNetworkFailure(code, message) {
  return ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH'].includes(code)
    || message.includes('network')
    || message.includes('fetch failed')
    || message.includes('socket hang up');
}

function logSanitizedDiagnostic(logger, nodeEnvironment, originalError, controlledError, snapshot, failures) {
  if (nodeEnvironment === 'production') {
    return;
  }
  const upstream = originalError instanceof OpenRouterDecisionError ? undefined : getUpstreamErrorInfo(originalError);
  logger.warn?.('OpenRouter decision request failed.', {
    code: controlledError.code,
    tickId: snapshot.tickId,
    scenarioId: snapshot.scenarioId,
    ...(upstream ? { upstreamError: upstream } : {}),
    ...(originalError?.responseDiagnostics ? { responseMetadata: originalError.responseDiagnostics } : {}),
    ...(nodeEnvironment === 'development' && originalError?.validationDiagnostics
      ? { decisionValidation: originalError.validationDiagnostics }
      : {}),
    ...(failures.length > 1 ? {
      attempts: failures.map(({ originalError: attemptError, controlledError: attemptControlledError }) => ({
        code: attemptControlledError.code,
        upstreamError: attemptError instanceof OpenRouterDecisionError ? undefined : getUpstreamErrorInfo(attemptError),
        ...(attemptError?.responseDiagnostics ? { responseMetadata: attemptError.responseDiagnostics } : {}),
        ...(nodeEnvironment === 'development' && attemptError?.validationDiagnostics
          ? { decisionValidation: attemptError.validationDiagnostics }
          : {}),
      })),
    } : {}),
  });
}

function readHeader(headers, name) {
  if (typeof headers?.get === 'function') {
    return headers.get(name);
  }
  if (headers && typeof headers === 'object') {
    return headers[name] ?? headers[name.toLowerCase()];
  }
  return undefined;
}

function sanitizeUpstreamMessage(value) {
  if (typeof value !== 'string') {
    return 'No upstream message was provided.';
  }
  return value
    .replace(/AIza[\w-]+/g, '[REDACTED_API_KEY]')
    .replace(/sk-or-v1-[\w-]+/g, '[REDACTED_API_KEY]')
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

function readBoundedInteger(value, fallback, minimum, maximum) {
  if (value === undefined || value === '') {
    return fallback;
  }
  const parsedValue = Number(value);
  if (!Number.isInteger(parsedValue)) {
    return fallback;
  }
  return parsedValue >= minimum && parsedValue <= maximum ? parsedValue : fallback;
}
