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
  assert.match(systemPrompt, /Select a non-empty fair combination/i);
  assert.match(systemPrompt, /Waiting time is a priority signal; it is not a reason to make that vehicle WAIT by default/i);
  assert.match(systemPrompt, /geometry-compatible is affirmative support to consider GO for both/i);
  assert.match(systemPrompt, /Do not return all WAIT merely because some candidates conflict with each other/i);
  assert.match(systemPrompt, /CONFLICT_CONCERN only for an actual supplied conflict/i);
  assert.match(systemPrompt, /decisions MUST be an array, never an object keyed by vehicle ID/i);
  assert.match(systemPrompt, /"tickId": "the exact input tickId string"/);
  assert.match(systemPrompt, /"vehicleId": "one eligible vehicle ID", "action": "GO", "reasonCode": "PRIORITY"/);
});

test('prompt fixtures require a known-clear compatible combination to be considered', () => {
  const exampleByName = new Map(PROMPT_EXAMPLES.map((example) => [example.name, example]));
  const liveExample = exampleByName.get('four-eligible-approaches');
  const compatible = exampleByName.get('application-supplied-compatibility-note');
  const conflicting = exampleByName.get('conflicting-eligible-movements');
  const crossing = exampleByName.get('crossing-vehicle');
  const fairness = exampleByName.get('long-waiting-vehicle');
  const incomplete = exampleByName.get('incomplete-occupancy');
  const missingCompatibility = exampleByName.get('missing-compatibility-information');

  const liveVehicleFacts = Object.fromEntries(liveExample.snapshot.vehicles
    .filter((vehicle) => liveExample.snapshot.eligibleVehicleIds.includes(vehicle.id))
    .map((vehicle) => [vehicle.id, [vehicle.incomingDirection, vehicle.route]]));
  assert.deepEqual(liveVehicleFacts, {
    V001: ['NORTH', 'LEFT'],
    V006: ['SOUTH', 'STRAIGHT'],
    V011: ['EAST', 'RIGHT'],
    V016: ['WEST', 'LEFT'],
  });
  assert.deepEqual(liveExample.snapshot.intersection.conflictInformation.compatibilityNotes, [
    'V001 conflicts with V006; do not recommend GO for both in this tick.',
    'V001 and V011 are geometry-compatible and may be considered together.',
    'V001 conflicts with V016; do not recommend GO for both in this tick.',
    'V006 conflicts with V011; do not recommend GO for both in this tick.',
    'V006 and V016 are geometry-compatible and may be considered together.',
    'V011 and V016 are geometry-compatible and may be considered together.',
  ]);
  const liveGoIds = liveExample.response.decisions
    .filter((decision) => decision.action === 'GO')
    .map((decision) => decision.vehicleId);
  assert.equal(liveGoIds.length, 2);
  assert.equal(liveGoIds.length < liveExample.snapshot.eligibleVehicleIds.length, true);
  assert.equal(
    liveExample.snapshot.intersection.conflictInformation.compatibilityNotes.some((note) => (
      note === `${liveGoIds[0]} and ${liveGoIds[1]} are geometry-compatible and may be considered together.`
      || note === `${liveGoIds[1]} and ${liveGoIds[0]} are geometry-compatible and may be considered together.`
    )),
    true,
  );
  assert.equal(
    liveExample.snapshot.intersection.conflictInformation.compatibilityNotes.some((note) => (
      note.startsWith(`${liveGoIds[0]} conflicts with ${liveGoIds[1]};`)
      || note.startsWith(`${liveGoIds[1]} conflicts with ${liveGoIds[0]};`)
    )),
    false,
  );
  assert.match(buildDecisionPrompt(liveExample.snapshot), /geometry-compatible and may be considered together/);

  assert.equal(compatible.response.decisions.filter((decision) => decision.action === 'GO').length, 2);
  assert.match(buildDecisionPrompt(compatible.snapshot), /may be considered together/);

  assert.equal(conflicting.response.decisions.filter((decision) => decision.action === 'GO').length, 1);
  assert.match(buildDecisionPrompt(conflicting.snapshot), /do not recommend GO for both/);

  assert.equal(crossing.response.decisions.every((decision) => decision.action === 'WAIT'), true);
  assert.match(buildDecisionPrompt(crossing.snapshot), /currently crossing/);
  assert.match(buildDecisionPrompt(crossing.snapshot), /conflicts with currently crossing/);

  assert.equal(fairness.response.decisions.find((decision) => decision.vehicleId === 'V001').action, 'GO');
  assert.equal(fairness.response.decisions.find((decision) => decision.vehicleId === 'V006').action, 'WAIT');

  assert.equal(incomplete.snapshot.intersection.occupancy.known, false);
  assert.equal(incomplete.response.decisions.every((decision) => decision.action === 'WAIT'), true);

  assert.equal(missingCompatibility.snapshot.intersection.conflictInformation, undefined);
  assert.equal(missingCompatibility.response.decisions.every((decision) => decision.action === 'WAIT'), true);
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
