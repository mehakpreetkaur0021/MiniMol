import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDecisionPrompt,
  buildSystemPrompt,
  buildTrafficSnapshot,
  validateTrafficSnapshot,
} from '../../src/ai/promptBuilder.js';
import {
  DECISION_ACTIONS,
  DECISION_REASON_CODES,
  DECISION_RESPONSE_SCHEMA,
  validateDecisionResponseShape,
} from '../../src/ai/decisionSchema.js';
import { PROMPT_EXAMPLES } from '../../src/ai/promptExamples.js';

const validExample = PROMPT_EXAMPLES[0];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function expectInvalid(mutator, expectedErrorFragment) {
  const snapshot = clone(validExample.snapshot);
  mutator(snapshot);
  const validation = validateTrafficSnapshot(snapshot);
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join(' '), new RegExp(expectedErrorFragment));
}

test('valid snapshots normalize and build a complete deterministic decision prompt', () => {
  const normalized = buildTrafficSnapshot(validExample.snapshot);
  const prompt = buildDecisionPrompt(validExample.snapshot);

  assert.equal(normalized.vehicles.length, 20);
  assert.deepEqual(normalized.eligibleVehicleIds, ['V001', 'V006', 'V011', 'V016']);
  assert.match(prompt, /example-four-eligible/);
  assert.match(prompt, /prompt-examples-scenario/);
  assert.match(prompt, /V020/);
  assert.match(prompt, /eligibleVehicleIds/);
  assert.equal(prompt, buildDecisionPrompt(clone(validExample.snapshot)));
});

test('prompt contains crossing and occupancy information when present', () => {
  const crossingExample = PROMPT_EXAMPLES.find(({ name }) => name === 'crossing-vehicle');
  const prompt = buildDecisionPrompt(crossingExample.snapshot);

  assert.match(prompt, /V001/);
  assert.match(prompt, /central-conflict-area/);
  assert.match(prompt, /currentlyCrossingVehicleIds/);
});

test('system prompt establishes proposal-only authority and strict response rules', () => {
  const systemPrompt = buildSystemPrompt();

  assert.match(systemPrompt, /recommendations only/);
  assert.match(systemPrompt, /deterministic safety validator/i);
  assert.match(systemPrompt, /eligibleVehicleIds/);
  assert.match(systemPrompt, /Return JSON only/);
});

test('snapshot validation rejects missing metadata and vehicle contract violations', () => {
  expectInvalid((snapshot) => { delete snapshot.tickId; }, 'tickId');
  expectInvalid((snapshot) => { delete snapshot.scenarioId; }, 'scenarioId');
  expectInvalid((snapshot) => { delete snapshot.vehicles[0].speed; }, 'speed');
  expectInvalid((snapshot) => { snapshot.vehicles[0].id = snapshot.vehicles[1].id; }, 'duplicated');
  expectInvalid((snapshot) => { snapshot.vehicles[0].incomingDirection = 'UP'; }, 'incomingDirection');
  expectInvalid((snapshot) => { snapshot.vehicles[0].route = 'UTURN'; }, 'route');
  expectInvalid((snapshot) => { snapshot.vehicles[0].status = 'MOVING'; }, 'status');
  expectInvalid((snapshot) => { snapshot.eligibleVehicleIds = ['unknown']; }, 'does not exist');
  expectInvalid((snapshot) => { snapshot.eligibleVehicleIds = ['V002']; }, 'WAITING at the stop line');
  expectInvalid((snapshot) => { snapshot.vehicles.pop(); }, 'exactly 20');
});

test('invalid snapshots are rejected instead of being serialized', () => {
  const invalidSnapshot = clone(validExample.snapshot);
  invalidSnapshot.eligibleVehicleIds = ['V002'];

  assert.throws(
    () => buildTrafficSnapshot(invalidSnapshot),
    /Traffic snapshot validation failed/,
  );
});

test('decision schema publishes the documented strict response contract', () => {
  assert.equal(DECISION_RESPONSE_SCHEMA.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.deepEqual(DECISION_ACTIONS, ['GO', 'WAIT']);
  assert.deepEqual(DECISION_REASON_CODES, [
    'PRIORITY',
    'FAIRNESS',
    'WAITING_TIME',
    'CONFLICT_CONCERN',
    'OCCUPIED_INTERSECTION',
    'DEFERRED',
  ]);
  assert.equal(validateDecisionResponseShape({ tickId: 'tick-empty', decisions: [] }).valid, true);
  assert.equal(validateDecisionResponseShape({
    tickId: 'tick-invalid',
    decisions: [{ vehicleId: 'V001', action: 'MOVE', reasonCode: 'UNKNOWN', extra: true }],
  }).valid, false);
  assert.equal(validateDecisionResponseShape({ tickId: 'tick-extra', decisions: [], explanation: 'not allowed' }).valid, false);
});

test('all prompt examples have valid snapshots and structural decision responses', () => {
  PROMPT_EXAMPLES.forEach((example) => {
    const snapshotValidation = validateTrafficSnapshot(example.snapshot);
    const responseValidation = validateDecisionResponseShape(example.response);
    const responseIds = example.response.decisions.map((decision) => decision.vehicleId).sort();
    const eligibleIds = [...example.snapshot.eligibleVehicleIds].sort();

    assert.equal(snapshotValidation.valid, true, `${example.name}: ${snapshotValidation.errors.join(' ')}`);
    assert.equal(responseValidation.valid, true, `${example.name}: ${responseValidation.errors.join(' ')}`);
    assert.equal(example.response.tickId, example.snapshot.tickId, `${example.name}: tick ID mismatch`);
    assert.deepEqual(responseIds, eligibleIds, `${example.name}: decision coverage mismatch`);
    assert.equal(new Set(responseIds).size, responseIds.length, `${example.name}: duplicate decision ID`);
  });
});
