import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createOpenRouterDecisionService,
  OpenRouterDecisionError,
} from '../../src/ai/openrouterDecisionService.js';
import { PROMPT_EXAMPLES } from '../../src/ai/promptExamples.js';

const successfulExample = PROMPT_EXAMPLES[1];
const fourEligibleExample = PROMPT_EXAMPLES.find(({ name }) => name === 'four-eligible-approaches');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function response(status, payload, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name] ?? headers[name.toLowerCase()] ?? null },
    text: async () => JSON.stringify(payload),
  };
}

function completion(content, {
  finishReason = 'stop',
  nativeFinishReason,
  message = {},
  usage,
  model = 'nvidia/nemotron-3.5-lightning:free',
  provider,
} = {}) {
  return response(200, {
    choices: [{ finish_reason: finishReason, native_finish_reason: nativeFinishReason, message: { content, ...message } }],
    usage,
    model,
    provider,
  });
}

function createService({
  responses = [completion(JSON.stringify(successfulExample.response))],
  environment = {},
  logger = { warn() {} },
  sleep = async () => {},
  now = () => Date.now(),
} = {}) {
  const requests = [];
  const sleeps = [];
  let responseIndex = 0;
  const service = createOpenRouterDecisionService({
    environment: {
      OPENROUTER_API_KEY: 'sk-or-v1-test-key',
      OPENROUTER_MODEL: 'nvidia/nemotron-3.5-lightning:free',
      OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
      OPENROUTER_MAX_RETRIES: '0',
      ...environment,
    },
    logger,
    now,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      await sleep(milliseconds);
    },
    random: () => 0,
    fetchImplementation: async (url, options) => {
      requests.push({ url, options });
      const nextResponse = responses[Math.min(responseIndex, responses.length - 1)];
      responseIndex += 1;
      if (nextResponse instanceof Error) {
        throw nextResponse;
      }
      if (typeof nextResponse === 'function') {
        return nextResponse(url, options);
      }
      return nextResponse;
    },
  });

  return { service, requests, sleeps };
}

async function expectInvalidResponse(modelResponse) {
  const { service } = createService({ responses: [completion(JSON.stringify(modelResponse))] });
  await assert.rejects(
    () => service.requestDecision(clone(successfulExample.snapshot)),
    (error) => error instanceof OpenRouterDecisionError && error.code.startsWith('OPENROUTER_'),
  );
}

test('sends an OpenRouter Chat Completions request and returns a validated decision', async () => {
  const { service, requests } = createService();
  const result = await service.requestDecision(clone(successfulExample.snapshot));

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(requests[0].options.method, 'POST');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer sk-or-v1-test-key');
  assert.equal(requests[0].options.headers['X-Title'], 'MiniMol');
  const requestBody = JSON.parse(requests[0].options.body);
  assert.equal(requestBody.model, 'nvidia/nemotron-3.5-lightning:free');
  assert.equal(requestBody.stream, false);
  assert.equal(requestBody.temperature, 0.1);
  assert.equal(requestBody.reasoning_effort, 'none');
  assert.equal(requestBody.messages[0].role, 'system');
  assert.match(requestBody.messages[0].content, /recommendations only/);
  assert.match(requestBody.messages[1].content, new RegExp(successfulExample.snapshot.tickId));
  assert.deepEqual(result.decisions, successfulExample.response.decisions);
  assert.equal(result.provider, 'OpenRouter');
  assert.equal(result.scenarioId, successfulExample.snapshot.scenarioId);
});

test('adds optional OpenRouter HTTP-Referer attribution', async () => {
  const { service, requests } = createService({ environment: { OPENROUTER_HTTP_REFERER: 'https://minimol.example' } });
  await service.requestDecision(clone(successfulExample.snapshot));

  assert.equal(requests[0].options.headers['HTTP-Referer'], 'https://minimol.example');
});

test('emits a compact snapshot-and-decision audit only in development', async () => {
  const audits = [];
  const { service } = createService({
    environment: { NODE_ENV: 'development' },
    logger: { warn() {}, info: (...args) => audits.push(args) },
  });

  await service.requestDecision(clone(successfulExample.snapshot));

  assert.equal(audits.length, 1);
  assert.equal(audits[0][0], 'OpenRouter traffic decision audit.');
  assert.deepEqual(audits[0][1].currentlyCrossingVehicleIds, ['V001']);
  assert.deepEqual(audits[0][1].eligibleVehicles.map((vehicle) => vehicle.vehicleId), ['V006']);
  assert.deepEqual(audits[0][1].decisions, successfulExample.response.decisions);
  assert.equal(audits[0][1].decisionSummary.waitCount, 1);
  assert.equal('messages' in audits[0][1], false);
});

test('accepts a valid decision JSON object surrounded by Markdown fences', async () => {
  const responseText = `\`\`\`json\n${JSON.stringify(successfulExample.response)}\n\`\`\``;
  const { service } = createService({ responses: [completion(responseText)] });
  const result = await service.requestDecision(clone(successfulExample.snapshot));

  assert.equal(result.tickId, successfulExample.snapshot.tickId);
});

test('safely extracts a valid decision JSON object from explanatory text', async () => {
  const responseText = `Decision recommendation follows.\n${JSON.stringify(successfulExample.response)}\nEnd recommendation.`;
  const { service } = createService({ responses: [completion(responseText)] });
  const result = await service.requestDecision(clone(successfulExample.snapshot));

  assert.deepEqual(result.decisions, successfulExample.response.decisions);
});

test('normalizes an unambiguous vehicle-ID decision map before strict validation', async () => {
  const mappedResponse = {
    tickId: successfulExample.response.tickId,
    decisions: Object.fromEntries(successfulExample.response.decisions.map(({ vehicleId, action, reasonCode }) => [
      vehicleId,
      { action, reasonCode },
    ])),
  };
  const { service } = createService({ responses: [completion(JSON.stringify(mappedResponse))] });

  const result = await service.requestDecision(clone(successfulExample.snapshot));

  assert.deepEqual(result.decisions, successfulExample.response.decisions);
});

test('rejects ambiguous or incomplete decision maps after normalization', async () => {
  const incompleteMap = {
    tickId: fourEligibleExample.response.tickId,
    decisions: {
      V001: { action: 'GO', reasonCode: 'PRIORITY' },
    },
  };
  const incomplete = createService({ responses: [completion(JSON.stringify(incompleteMap))] });
  await assert.rejects(
    () => incomplete.service.requestDecision(clone(fourEligibleExample.snapshot)),
    (error) => error.code === 'OPENROUTER_INVALID_DECISION_COVERAGE',
  );

  const ambiguousMap = {
    tickId: successfulExample.response.tickId,
    decisions: {
      V006: { vehicleId: 'V999', action: 'GO', reasonCode: 'PRIORITY' },
    },
  };
  const ambiguous = createService({ responses: [completion(JSON.stringify(ambiguousMap))] });
  await assert.rejects(
    () => ambiguous.service.requestDecision(clone(successfulExample.snapshot)),
    (error) => error.code === 'OPENROUTER_INVALID_DECISION_SCHEMA',
  );

  const missingFieldMap = {
    tickId: successfulExample.response.tickId,
    decisions: { V006: { action: 'GO' } },
  };
  const missingField = createService({ responses: [completion(JSON.stringify(missingFieldMap))] });
  await assert.rejects(
    () => missingField.service.requestDecision(clone(successfulExample.snapshot)),
    (error) => error.code === 'OPENROUTER_INVALID_DECISION_SCHEMA',
  );
});

test('classifies an HTTP 200 response with empty model content and logs safe metadata only', async () => {
  const logs = [];
  const privateReasoning = 'private hidden reasoning must never be logged';
  const { service } = createService({
    environment: { NODE_ENV: 'development' },
    logger: { warn: (...args) => logs.push(args) },
    responses: [completion('', {
      message: { reasoning: privateReasoning, reasoning_details: [{ text: privateReasoning }] },
      usage: { prompt_tokens: 123, completion_tokens: 0 },
      provider: 'NVIDIA',
    })],
  });

  await assert.rejects(
    () => service.requestDecision(clone(successfulExample.snapshot)),
    (error) => error.code === 'OPENROUTER_EMPTY_MODEL_RESPONSE',
  );
  const diagnostic = logs[0][1].responseMetadata;
  assert.deepEqual(diagnostic, {
    httpStatus: 200,
    hasTopLevelError: false,
    topLevelErrorCode: null,
    choicesPresent: true,
    choiceCount: 1,
    messagePresent: true,
    contentPresent: false,
    contentLength: 0,
    reasoningPresent: true,
    reasoningDetailsPresent: true,
    finishReason: 'stop',
    nativeFinishReason: null,
    promptTokens: 123,
    completionTokens: 0,
    reasoningTokens: null,
    returnedModel: 'nvidia/nemotron-3.5-lightning:free',
    provider: 'NVIDIA',
  });
  assert.equal(JSON.stringify(logs).includes(privateReasoning), false);
});

test('identifies output truncation and reasoning-token budget exhaustion', async () => {
  const truncated = createService({ responses: [completion('', {
    finishReason: 'length',
    usage: { prompt_tokens: 100, completion_tokens: 1024 },
  })] });
  await assert.rejects(
    () => truncated.service.requestDecision(clone(successfulExample.snapshot)),
    (error) => error.code === 'OPENROUTER_OUTPUT_TRUNCATED',
  );

  const reasoningExhausted = createService({ responses: [completion('', {
    finishReason: 'length',
    usage: {
      prompt_tokens: 100,
      completion_tokens: 1024,
      completion_tokens_details: { reasoning_tokens: 1024 },
    },
  })] });
  await assert.rejects(
    () => reasoningExhausted.service.requestDecision(clone(successfulExample.snapshot)),
    (error) => error.code === 'OPENROUTER_REASONING_TOKEN_EXHAUSTED',
  );
});

test('rejects an upstream provider error embedded in an HTTP 200 response', async () => {
  const { service } = createService({
    responses: [response(200, { error: { code: 'PROVIDER_ERROR', message: 'Upstream provider failed.' } })],
  });

  await assert.rejects(
    () => service.requestDecision(clone(successfulExample.snapshot)),
    (error) => error.code === 'OPENROUTER_PROVIDER_ERROR' && error.message === 'OpenRouter returned an upstream provider error.',
  );
});

test('rejects malformed and contract-invalid OpenRouter decision responses', async () => {
  const malformed = createService({ responses: [completion('not valid JSON')] });
  await assert.rejects(
    () => malformed.service.requestDecision(clone(successfulExample.snapshot)),
    (error) => error.code === 'OPENROUTER_MALFORMED_DECISION_JSON',
  );

  const missing = clone(successfulExample.response);
  missing.decisions = [];
  await expectInvalidResponse(missing);

  const extra = clone(successfulExample.response);
  extra.decisions[0].vehicleId = 'V999';
  await expectInvalidResponse(extra);

  const duplicate = clone(successfulExample.response);
  duplicate.decisions.push(clone(duplicate.decisions[0]));
  await expectInvalidResponse(duplicate);

  const wrongTick = clone(successfulExample.response);
  wrongTick.tickId = 'wrong-tick';
  await expectInvalidResponse(wrongTick);

  const unsupportedScenario = { ...clone(successfulExample.response), scenarioId: 'wrong-scenario' };
  await expectInvalidResponse(unsupportedScenario);

  const invalidDecision = clone(successfulExample.response);
  invalidDecision.decisions[0].action = 'MOVE';
  await expectInvalidResponse(invalidDecision);

  const invalidReason = clone(successfulExample.response);
  invalidReason.decisions[0].reasonCode = 'UNSAFE';
  await expectInvalidResponse(invalidReason);
});

test('reports safe rule-level diagnostics for an invalid decision structure in development', async () => {
  const logs = [];
  const secretPromptFragment = 'do-not-log-this-model-content';
  const invalidStructure = {
    tickId: successfulExample.snapshot.tickId,
    explanation: 'not allowed',
    decisions: [
      {
        vehicle_id: 'V006',
        action: 'PROCEED',
        reasonCode: 'UNSAFE',
        privatePrompt: secretPromptFragment,
      },
      { vehicleId: 'V999', action: 'GO', reasonCode: 'PRIORITY' },
    ],
  };
  const { service } = createService({
    environment: { NODE_ENV: 'development' },
    logger: { warn: (...args) => logs.push(args) },
    responses: [completion(JSON.stringify(invalidStructure))],
  });

  await assert.rejects(
    () => service.requestDecision(clone(successfulExample.snapshot)),
    (error) => error.code === 'OPENROUTER_INVALID_DECISION_SCHEMA'
      && error.message === 'OpenRouter returned an invalid decision structure.',
  );

  const diagnostic = logs[0][1].decisionValidation;
  assert.deepEqual(diagnostic.expectedStructure.requiredTopLevelFields, ['tickId', 'decisions']);
  assert.deepEqual(diagnostic.expectedStructure.allowedActions, ['GO', 'WAIT']);
  assert.deepEqual(diagnostic.actualStructure.topLevelFieldNames, ['tickId', 'explanation', 'decisions']);
  assert.deepEqual(diagnostic.actualStructure.decisions[0].missingFields, ['vehicleId']);
  assert.deepEqual(diagnostic.actualStructure.decisions[0].extraFields, ['vehicle_id', 'privatePrompt']);
  assert.equal(diagnostic.actualStructure.decisions[0].invalidAction, 'PROCEED');
  assert.equal(diagnostic.actualStructure.decisions[0].invalidReasonCode, 'UNSAFE');
  assert.deepEqual(diagnostic.vehicleCoverage.missingVehicleIds, ['V006']);
  assert.deepEqual(diagnostic.vehicleCoverage.extraVehicleIds, ['V999']);
  assert.match(diagnostic.failedRules.join(' '), /Unsupported response fields/);
  assert.equal(JSON.stringify(logs).includes(secretPromptFragment), false);
});

test('maps authentication, rate limit, unavailable, timeout, and network failures safely', async () => {
  const cases = [
    [response(401, { error: { message: 'Invalid API key.' } }), 'OPENROUTER_AUTHENTICATION', 401],
    [response(429, { error: { message: 'Too many requests.' } }), 'OPENROUTER_RATE_LIMITED', 429],
    [response(503, { error: { message: 'Provider unavailable.' } }), 'OPENROUTER_UNAVAILABLE', 503],
    [Object.assign(new Error('request timeout'), { name: 'AbortError' }), 'OPENROUTER_TIMEOUT', 504],
    [Object.assign(new Error('fetch failed'), { code: 'ENOTFOUND' }), 'OPENROUTER_NETWORK_ERROR', 503],
  ];

  for (const [upstreamResponse, code, status] of cases) {
    const { service } = createService({ responses: [upstreamResponse] });
    await assert.rejects(
      () => service.requestDecision(clone(successfulExample.snapshot)),
      (error) => error.code === code && error.httpStatus === status,
    );
  }
});

test('retries transient failures and honors Retry-After', async () => {
  const { service, requests, sleeps } = createService({
    environment: { OPENROUTER_MAX_RETRIES: '2' },
    responses: [
      response(429, { error: { message: 'Too many requests.' } }, { 'retry-after': '2' }),
      completion(JSON.stringify(successfulExample.response)),
    ],
  });

  const result = await service.requestDecision(clone(successfulExample.snapshot));
  assert.equal(result.tickId, successfulExample.snapshot.tickId);
  assert.equal(requests.length, 2);
  assert.deepEqual(sleeps, [2_000]);
});

test('does not retry authentication or invalid-request failures', async () => {
  const { service, requests } = createService({
    environment: { OPENROUTER_MAX_RETRIES: '2' },
    responses: [response(401, { error: { message: 'Invalid API key.' } })],
  });
  await assert.rejects(() => service.requestDecision(clone(successfulExample.snapshot)));
  assert.equal(requests.length, 1);
});

test('does not expose API keys in diagnostics or returned errors', async () => {
  const logs = [];
  const secret = 'sk-or-v1-sensitive-openrouter-key';
  const { service } = createService({
    environment: { NODE_ENV: 'development', OPENROUTER_API_KEY: secret },
    logger: { warn: (...args) => logs.push(args) },
    responses: [response(400, { error: { message: `Invalid request Bearer ${secret}` } })],
  });

  let thrownError;
  await assert.rejects(
    () => service.requestDecision(clone(successfulExample.snapshot)),
    (error) => {
      thrownError = error;
      return true;
    },
  );
  const output = JSON.stringify({ logs, error: { code: thrownError.code, message: thrownError.message } });
  assert.equal(output.includes(secret), false);
  assert.equal(thrownError.message.includes('Bearer'), false);
});

test('shares in-flight work, caches valid results, and protects duplicate tick fingerprints', async () => {
  let resolveResponse;
  const pendingResponse = new Promise((resolve) => { resolveResponse = resolve; });
  const { service, requests } = createService({ responses: [async () => pendingResponse] });
  const firstRequest = service.requestDecision(clone(successfulExample.snapshot));
  const secondRequest = service.requestDecision(clone(successfulExample.snapshot));

  assert.equal(requests.length, 1);
  resolveResponse(completion(JSON.stringify(successfulExample.response)));
  const [firstResult, secondResult] = await Promise.all([firstRequest, secondRequest]);
  const cachedResult = await service.requestDecision(clone(successfulExample.snapshot));
  assert.equal(firstResult.cached, false);
  assert.equal(secondResult.cached, false);
  assert.equal(cachedResult.cached, true);

  const conflictingSnapshot = clone(successfulExample.snapshot);
  conflictingSnapshot.simulationTimeSeconds += 1;
  await assert.rejects(
    () => service.requestDecision(conflictingSnapshot),
    (error) => error.code === 'DUPLICATE_TICK_CONFLICT',
  );
});

test('requires an OpenRouter API key without issuing an HTTP request', async () => {
  let calls = 0;
  const service = createOpenRouterDecisionService({
    environment: {},
    fetchImplementation: async () => {
      calls += 1;
      return completion(JSON.stringify(successfulExample.response));
    },
    logger: { warn() {} },
  });

  await assert.rejects(
    () => service.requestDecision(clone(successfulExample.snapshot)),
    (error) => error.code === 'MISSING_API_KEY',
  );
  assert.equal(calls, 0);
});
