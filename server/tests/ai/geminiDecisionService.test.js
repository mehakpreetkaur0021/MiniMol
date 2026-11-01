import assert from 'node:assert/strict';
import test from 'node:test';
import { createAiDecisionController } from '../../src/controllers/aiDecisionController.js';
import {
  createGeminiDecisionService,
  createProviderDecisionSchema,
  GeminiDecisionError,
} from '../../src/ai/geminiDecisionService.js';
import { PROMPT_EXAMPLES } from '../../src/ai/promptExamples.js';

const successfulExample = PROMPT_EXAMPLES[1];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createService({ response = successfulExample.response, rawResponseText, rejectWith, maxCacheEntries, environment, logger = { warn() {} } } = {}) {
  let calls = 0;
  let latestRequest;
  const service = createGeminiDecisionService({
    environment: environment ?? {
      GEMINI_API_KEY_1: 'test-key',
      GEMINI_MODEL: 'gemini-3.8-flash',
      GEMINI_TIMEOUT_MS: '180000',
    },
    maxCacheEntries,
    logger,
    clientFactory: () => ({
      models: {
        async generateContent(request) {
          calls += 1;
          latestRequest = request;
          if (rejectWith) {
            throw rejectWith;
          }
          const responseBody = typeof response === 'function' ? response(request) : response;
          return { text: rawResponseText ?? JSON.stringify(responseBody), request };
        },
      },
    }),
  });

  return { service, getCalls: () => calls, getLatestRequest: () => latestRequest };
}

function createFallbackService({ environment, outcomes, logger = { warn() {} } }) {
  const attemptedKeys = [];
  const service = createGeminiDecisionService({
    environment,
    logger,
    clientFactory: ({ apiKey }) => ({
      models: {
        async generateContent() {
          attemptedKeys.push(apiKey);
          const outcome = outcomes[apiKey];
          if (outcome instanceof Error || outcome?.error) {
            throw (outcome.error ?? outcome);
          }
          return { text: JSON.stringify(outcome ?? successfulExample.response) };
        },
      },
    }),
  });

  return { service, attemptedKeys };
}

async function expectInvalidResponse(response) {
  const { service } = createService({ response });
  await assert.rejects(
    () => service.requestDecision(clone(successfulExample.snapshot)),
    (error) => error instanceof GeminiDecisionError && error.code === 'INVALID_MODEL_RESPONSE',
  );
}

test('missing Gemini API key is rejected without creating a client', async () => {
  let clientCreated = false;
  const service = createGeminiDecisionService({
    environment: { GEMINI_MODEL: 'gemini-3.8-flash' },
    logger: { warn() {} },
    clientFactory: () => {
      clientCreated = true;
      return {};
    },
  });

  await assert.rejects(
    () => service.requestDecision(clone(successfulExample.snapshot)),
    (error) => error.code === 'MISSING_API_KEY',
  );
  assert.equal(clientCreated, false);
});

test('the first configured key succeeds with one request', async () => {
  const { service, attemptedKeys } = createFallbackService({
    environment: { GEMINI_API_KEY_1: 'key-1' },
    outcomes: { 'key-1': successfulExample.response },
  });

  await service.requestDecision(clone(successfulExample.snapshot));
  assert.deepEqual(attemptedKeys, ['key-1']);
});

test('a failed first key falls back to the second key', async () => {
  const { service, attemptedKeys } = createFallbackService({
    environment: { GEMINI_API_KEY_1: 'key-1', GEMINI_API_KEY_2: 'key-2' },
    outcomes: {
      'key-1': { error: { status: 429, message: 'Quota exceeded.' } },
      'key-2': successfulExample.response,
    },
  });

  await service.requestDecision(clone(successfulExample.snapshot));
  assert.deepEqual(attemptedKeys, ['key-1', 'key-2']);
});

test('failed first and second keys fall back to the third key', async () => {
  const { service, attemptedKeys } = createFallbackService({
    environment: { GEMINI_API_KEY_1: 'key-1', GEMINI_API_KEY_2: 'key-2', GEMINI_API_KEY_3: 'key-3' },
    outcomes: {
      'key-1': { error: { status: 400, message: 'Invalid request.' } },
      'key-2': { error: { status: 503, message: 'Service unavailable.' } },
      'key-3': successfulExample.response,
    },
  });

  await service.requestDecision(clone(successfulExample.snapshot));
  assert.deepEqual(attemptedKeys, ['key-1', 'key-2', 'key-3']);
});

test('failed first three keys fall back to the fourth key', async () => {
  const { service, attemptedKeys } = createFallbackService({
    environment: {
      GEMINI_API_KEY_1: 'key-1', GEMINI_API_KEY_2: 'key-2', GEMINI_API_KEY_3: 'key-3', GEMINI_API_KEY_4: 'key-4',
    },
    outcomes: {
      'key-1': { error: { status: 401, message: 'Invalid API key.' } },
      'key-2': { error: { status: 403, message: 'Permission denied.' } },
      'key-3': { error: { status: 404, message: 'Model not found.' } },
      'key-4': successfulExample.response,
    },
  });

  await service.requestDecision(clone(successfulExample.snapshot));
  assert.deepEqual(attemptedKeys, ['key-1', 'key-2', 'key-3', 'key-4']);
});

test('all configured key failures return the final sanitized Gemini error', async () => {
  const { service, attemptedKeys } = createFallbackService({
    environment: {
      GEMINI_API_KEY_1: 'key-1', GEMINI_API_KEY_2: 'key-2', GEMINI_API_KEY_3: 'key-3', GEMINI_API_KEY_4: 'key-4',
    },
    outcomes: Object.fromEntries(['key-1', 'key-2', 'key-3', 'key-4'].map((key) => [key, {
      error: { status: 503, message: 'Service unavailable.' },
    }])),
  });

  await assert.rejects(
    () => service.requestDecision(clone(successfulExample.snapshot)),
    (error) => error.code === 'GEMINI_UNAVAILABLE' && error.message === 'Gemini is currently unavailable.',
  );
  assert.deepEqual(attemptedKeys, ['key-1', 'key-2', 'key-3', 'key-4']);
});

test('missing numbered keys are skipped while preserving configured key order', async () => {
  const { service, attemptedKeys } = createFallbackService({
    environment: { GEMINI_API_KEY_1: '  ', GEMINI_API_KEY_2: 'key-2', GEMINI_API_KEY_4: 'key-4' },
    outcomes: {
      'key-2': { error: new Error('network failure') },
      'key-4': successfulExample.response,
    },
  });

  await service.requestDecision(clone(successfulExample.snapshot));
  assert.deepEqual(attemptedKeys, ['key-2', 'key-4']);
});

test('fallback diagnostics and returned errors never expose configured API keys', async () => {
  const logs = [];
  const keyOne = 'AIzaSensitiveKeyOne';
  const keyTwo = 'AIzaSensitiveKeyTwo';
  const { service } = createFallbackService({
    environment: { NODE_ENV: 'development', GEMINI_API_KEY_1: keyOne, GEMINI_API_KEY_2: keyTwo },
    outcomes: {
      [keyOne]: { error: new Error(`request failed with key=${keyOne}`) },
      [keyTwo]: { error: new Error(`request failed with key=${keyTwo}`) },
    },
    logger: { warn: (...args) => logs.push(args) },
  });

  let error;
  await assert.rejects(
    () => service.requestDecision(clone(successfulExample.snapshot)),
    (caughtError) => {
      error = caughtError;
      return true;
    },
  );
  const output = JSON.stringify({ logs, error: { code: error.code, message: error.message } });
  assert.equal(output.includes(keyOne), false);
  assert.equal(output.includes(keyTwo), false);
});

test('a successful fallback response still passes existing response validation', async () => {
  const invalidResponse = { ...clone(successfulExample.response), tickId: 'wrong-tick' };
  const { service, attemptedKeys } = createFallbackService({
    environment: { GEMINI_API_KEY_1: 'key-1', GEMINI_API_KEY_2: 'key-2' },
    outcomes: { 'key-1': invalidResponse, 'key-2': successfulExample.response },
  });

  const result = await service.requestDecision(clone(successfulExample.snapshot));
  assert.equal(result.tickId, successfulExample.snapshot.tickId);
  assert.deepEqual(attemptedKeys, ['key-1', 'key-2']);
});

test('one new tick produces one structured Gemini request and normalized response', async () => {
  const { service, getCalls, getLatestRequest } = createService();
  const result = await service.requestDecision(clone(successfulExample.snapshot));

  assert.equal(getCalls(), 1);
  assert.deepEqual(result.decisions, successfulExample.response.decisions);
  assert.equal(result.tickId, successfulExample.snapshot.tickId);
  assert.equal(result.model, 'gemini-3.8-flash');
  assert.equal(result.cached, false);
  assert.equal(getLatestRequest().model, 'gemini-3.8-flash');
  assert.equal(getLatestRequest().config.responseMimeType, 'application/json');
  assert.equal(getLatestRequest().config.httpOptions.timeout, 180000);
  assert.equal(getLatestRequest().config.responseJsonSchema.type, 'object');
  assert.match(getLatestRequest().config.systemInstruction, /recommendations only/);
});

test('the default timeout is 180000 ms when GEMINI_TIMEOUT_MS is absent', async () => {
  let clientConfiguration;
  let requestConfiguration;
  const service = createGeminiDecisionService({
    environment: { GEMINI_API_KEY_1: 'test-key', GEMINI_MODEL: 'gemini-3.8-flash' },
    logger: { warn() {} },
    clientFactory: (configuration) => {
      clientConfiguration = configuration;
      return {
        models: {
          async generateContent(request) {
            requestConfiguration = request.config;
            return { text: JSON.stringify(successfulExample.response) };
          },
        },
      };
    },
  });

  await service.requestDecision(clone(successfulExample.snapshot));

  assert.equal(clientConfiguration.timeoutMs, 180000);
  assert.equal(requestConfiguration.httpOptions.timeout, 180000);
});

test('provider schema retains all required nested decision properties', () => {
  const schema = createProviderDecisionSchema();

  assert.equal(schema.type, 'object');
  assert.equal(schema.properties.tickId.type, 'string');
  assert.equal(schema.properties.decisions.type, 'array');
  assert.equal(schema.properties.decisions.items.properties.vehicleId.type, 'string');
  assert.deepEqual(schema.properties.decisions.items.required, ['vehicleId', 'action', 'reasonCode']);
  assert.equal('$schema' in schema, false);
  assert.equal('minLength' in schema.properties.tickId, false);
});

test('identical duplicate ticks share in-flight work and cache completed results', async () => {
  let calls = 0;
  let resolveGeneration;
  const service = createGeminiDecisionService({
    environment: { GEMINI_API_KEY_1: 'test-key', GEMINI_MODEL: 'gemini-3.8-flash' },
    logger: { warn() {} },
    clientFactory: () => ({
      models: {
        generateContent() {
          calls += 1;
          return new Promise((resolve) => { resolveGeneration = resolve; });
        },
      },
    }),
  });
  const firstRequest = service.requestDecision(clone(successfulExample.snapshot));
  const secondRequest = service.requestDecision(clone(successfulExample.snapshot));

  assert.equal(calls, 1);
  resolveGeneration({ text: JSON.stringify(successfulExample.response) });
  const [firstResult, secondResult] = await Promise.all([firstRequest, secondRequest]);
  const cachedResult = await service.requestDecision(clone(successfulExample.snapshot));

  assert.equal(firstResult.cached, false);
  assert.equal(secondResult.cached, false);
  assert.equal(cachedResult.cached, true);
  assert.equal(calls, 1);
});

test('an aborted request is mapped as a timeout and releases its in-flight tick', async () => {
  let calls = 0;
  const service = createGeminiDecisionService({
    environment: { GEMINI_API_KEY_1: 'test-key', GEMINI_MODEL: 'gemini-3.8-flash' },
    logger: { warn() {} },
    clientFactory: () => ({
      models: {
        async generateContent() {
          calls += 1;
          if (calls === 1) {
            const error = new Error('The request was aborted.');
            error.name = 'AbortError';
            throw error;
          }
          return { text: JSON.stringify(successfulExample.response) };
        },
      },
    }),
  });

  await assert.rejects(
    () => service.requestDecision(clone(successfulExample.snapshot)),
    (error) => error.code === 'GEMINI_TIMEOUT',
  );
  const retry = await service.requestDecision(clone(successfulExample.snapshot));

  assert.equal(calls, 2);
  assert.equal(retry.cached, false);
});

test('same tick with changed snapshot is rejected and cache remains bounded', async () => {
  const { service, getCalls } = createService({
    maxCacheEntries: 1,
    response: (request) => {
      const snapshotJson = request.contents.slice(
        request.contents.indexOf('\n') + 1,
        request.contents.lastIndexOf('\n\nReturn'),
      );
      return { ...successfulExample.response, tickId: JSON.parse(snapshotJson).tickId };
    },
  });
  const firstSnapshot = clone(successfulExample.snapshot);
  await service.requestDecision(firstSnapshot);

  const conflictingSnapshot = clone(successfulExample.snapshot);
  conflictingSnapshot.simulationTimeSeconds += 1;
  await assert.rejects(
    () => service.requestDecision(conflictingSnapshot),
    (error) => error.code === 'DUPLICATE_TICK_CONFLICT',
  );

  const nextSnapshot = clone(successfulExample.snapshot);
  nextSnapshot.tickId = 'next-tick';
  await service.requestDecision(nextSnapshot);
  assert.equal(getCalls(), 2);
  assert.equal(service.getCacheSize(), 1);
});

test('malformed and relationship-invalid Gemini responses are fully rejected', async () => {
  const malformedJson = createService({ rawResponseText: '{not-json' });
  await assert.rejects(() => malformedJson.service.requestDecision(clone(successfulExample.snapshot)), (error) => error.code === 'INVALID_MODEL_RESPONSE');
  const malformed = createService({ response: null });
  await assert.rejects(() => malformed.service.requestDecision(clone(successfulExample.snapshot)), (error) => error.code === 'INVALID_MODEL_RESPONSE');

  const wrongTick = clone(successfulExample.response);
  wrongTick.tickId = 'wrong-tick';
  await expectInvalidResponse(wrongTick);

  const duplicate = clone(successfulExample.response);
  duplicate.decisions.push(clone(duplicate.decisions[0]));
  await expectInvalidResponse(duplicate);

  const missing = clone(successfulExample.response);
  missing.decisions = [];
  await expectInvalidResponse(missing);

  const unknown = clone(successfulExample.response);
  unknown.decisions[0].vehicleId = 'V999';
  await expectInvalidResponse(unknown);

  const ineligible = clone(successfulExample.response);
  ineligible.decisions[0].vehicleId = 'V002';
  await expectInvalidResponse(ineligible);

  const invalidAction = clone(successfulExample.response);
  invalidAction.decisions[0].action = 'MOVE';
  await expectInvalidResponse(invalidAction);

  const invalidReason = clone(successfulExample.response);
  invalidReason.decisions[0].reasonCode = 'UNSAFE';
  await expectInvalidResponse(invalidReason);
});

test('provider HTTP and timeout failures are classified precisely', async () => {
  const cases = [
    [{ status: 400, message: 'Invalid response schema.' }, 'GEMINI_INVALID_REQUEST', 400],
    [{ status: 401, message: 'Invalid API key.' }, 'GEMINI_AUTHENTICATION', 401],
    [{ status: 403, message: 'Permission denied.' }, 'GEMINI_PERMISSION_DENIED', 403],
    [{ status: 404, message: 'Model not found.' }, 'GEMINI_MODEL_NOT_FOUND', 404],
    [{ status: 429, message: 'Quota exceeded.' }, 'GEMINI_RATE_LIMITED', 429],
    [{ status: 503, message: 'Service unavailable.' }, 'GEMINI_UNAVAILABLE', 503],
    [new Error('request timeout'), 'GEMINI_TIMEOUT', 504],
  ];

  for (const [upstreamError, code, httpStatus] of cases) {
    const failingService = createService({ rejectWith: upstreamError });
    await assert.rejects(
      () => failingService.service.requestDecision(clone(successfulExample.snapshot)),
      (error) => error.code === code && error.httpStatus === httpStatus,
    );
  }
});

test('development diagnostics retain useful upstream metadata but redact secrets', async () => {
  const logs = [];
  const secretLikeValue = 'AIzaSensitiveKeyShouldNeverAppear';
  const failingService = createService({
    environment: {
      NODE_ENV: 'development',
      GEMINI_API_KEY_1: 'test-key',
      GEMINI_MODEL: 'gemini-3.8-flash',
    },
    logger: { warn: (...args) => logs.push(args) },
    rejectWith: {
      name: 'ApiError',
      status: 400,
      code: 'INVALID_ARGUMENT',
      message: `Invalid schema: https://example.test/?key=${secretLikeValue}`,
    },
  });

  await assert.rejects(() => failingService.service.requestDecision(clone(successfulExample.snapshot)));
  assert.equal(logs.length, 1);
  const diagnostic = logs[0][1];
  assert.equal(diagnostic.upstreamError.name, 'ApiError');
  assert.equal(diagnostic.upstreamError.status, 400);
  assert.equal(diagnostic.upstreamError.code, 'INVALID_ARGUMENT');
  assert.equal(diagnostic.upstreamError.message.includes(secretLikeValue), false);
  assert.match(diagnostic.upstreamError.message, /REDACTED/);
});

test('controller returns sanitized errors without exposing configuration values', async () => {
  const controller = createAiDecisionController({
    requestDecision: async () => {
      throw new GeminiDecisionError('MISSING_API_KEY', 'Gemini API is not configured.', 503);
    },
  });
  const response = {
    statusCode: 0,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };

  await controller({ body: clone(successfulExample.snapshot) }, response);
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.error.code, 'MISSING_API_KEY');
  assert.equal(JSON.stringify(response.body).includes('test-key'), false);
});
