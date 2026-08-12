import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

import {observeFixture} from './fixture-observer.mjs';
import {validateAgainstSchemaPath} from './json-schema.mjs';
import {
  canonicalJson,
  operationDigest,
  operationFromAction,
  semanticSnapshot,
  stateDigest,
} from './semantic-kernel-core.mjs';
import {replayRecords} from './semantic-kernel-replay.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const supportedSequenceMaximum = 256;
const writerActor = {
  actor_id: 'person:owner-001',
  actor_kind: 'vault_owner',
  authority_ref: 'authority:vault-owner-001',
};

function canonicalMarkerRecord(sequence, idempotencyKey = `idempotency:${String(sequence).padStart(4, '0')}`) {
  const id = String(sequence).padStart(4, '0');
  const previousId = sequence === 1 ? null : `operation:${String(sequence - 1).padStart(4, '0')}`;
  const state = new Map();
  const result = operationFromAction({
    command_id: `command:${id}`,
    operation_id: `operation:${id}`,
    actor: writerActor,
    operation_kind: 'compatibility_marker',
    base_references: [{
      ordinal: 0,
      kind: 'semantic_head',
      sequence: sequence - 1,
      operation_id: previousId,
      state_digest: stateDigest(state),
    }],
    ordering: {
      sequence,
      predecessor_operation_id: previousId,
      sort_key: `${id}:command:${id}`,
    },
    payload: {events: [{
      event_id: `event:${id}`,
      ordinal: 0,
      event_kind: 'compatibility_marker',
      schema_version: '1.0.0',
      payload: {key: `compatibility:marker-${id}`, value: null},
    }]},
    idempotency_key: idempotencyKey,
    preconditions: [],
  }, state);
  assert.equal(result.code, null);
  return `${canonicalJson(result.operation)}\n`;
}

function markerRecords(count) {
  return Array.from({length: count}, (_, index) => canonicalMarkerRecord(index + 1));
}

function snapshotFromReplay(result) {
  assert.equal(result.code, null);
  return semanticSnapshot(result.state, result.head, result.history);
}

function emittedSnapshot(observed) {
  const output = observed.outputs.find((candidate) => candidate.startsWith('semantic_snapshot:'));
  assert.notEqual(output, undefined);
  return JSON.parse(output.slice('semantic_snapshot:'.length));
}

async function replayFixture(snapshot, records) {
  const fixture = JSON.parse(await readFile(
    new URL('./scenarios/semantic-kernel/snapshot-suffix-equivalence.json', import.meta.url),
    'utf8',
  ));
  assert.ok(fixture?.subject?.document?.action !== null &&
    typeof fixture?.subject?.document?.action === 'object',
  'snapshot-suffix-equivalence.json must supply action');
  assert.ok(fixture.subject.document.action.snapshot !== null &&
    typeof fixture.subject.document.action.snapshot === 'object',
  'snapshot-suffix-equivalence.json must supply action.snapshot');
  fixture.subject.document.action.snapshot = snapshot;
  fixture.subject.document.action.records = records;
  return observeFixture(fixture, packageRoot);
}

test('Semantic Kernel rejects duplicate keys in initial and snapshot state', async () => {
  const initialFixture = JSON.parse(await readFile(
    new URL('./scenarios/semantic-kernel/valid-initial-append.json', import.meta.url),
    'utf8',
  ));
  assert.ok(initialFixture?.subject?.document?.initial !== null &&
    typeof initialFixture?.subject?.document?.initial === 'object',
  'valid-initial-append.json must supply initial');
  initialFixture.subject.document.initial.semantic_state = [
    {key: 'note:001/placement', value: 'cat:research'},
    {key: 'note:001/placement', value: 'cat:projects'},
  ];
  const snapshotFixture = JSON.parse(await readFile(
    new URL('./scenarios/semantic-kernel/snapshot-suffix-equivalence.json', import.meta.url),
    'utf8',
  ));
  assert.ok(snapshotFixture?.subject?.document?.action?.snapshot !== null &&
    typeof snapshotFixture?.subject?.document?.action?.snapshot === 'object',
  'snapshot-suffix-equivalence.json must supply action.snapshot');
  snapshotFixture.subject.document.action.snapshot.semantic_state.push(
    {key: 'note:001/placement', value: 'cat:projects'},
  );

  const [initialObserved, snapshotObserved] = await Promise.all([
    observeFixture(initialFixture, packageRoot),
    observeFixture(snapshotFixture, packageRoot),
  ]);

  assert.deepEqual(initialObserved.codes, ['semantic.state_noncanonical']);
  assert.deepEqual(snapshotObserved.codes, ['semantic.state_noncanonical']);
});

test('Semantic Kernel accepts its exact sequence maximum and rejects every successor', async () => {
  const records = markerRecords(supportedSequenceMaximum);
  const prefix = await replayRecords(records.slice(0, -64), null, [], packageRoot);
  const full = await replayRecords(records, null, [], packageRoot);
  const observedMaximum = await replayFixture(snapshotFromReplay(prefix), records.slice(-64));
  const maximumSnapshot = emittedSnapshot(observedMaximum);
  assert.equal(observedMaximum.verdict, 'pass');
  assert.equal(maximumSnapshot.sequence, supportedSequenceMaximum);
  assert.equal(maximumSnapshot.history.length, supportedSequenceMaximum);
  assert.deepEqual(maximumSnapshot, snapshotFromReplay(full));

  const receiptFixture = JSON.parse(await readFile(
    new URL('./scenarios/semantic-kernel/stale-base-rejected.json', import.meta.url),
    'utf8',
  ));
  const receipt = JSON.parse(receiptFixture.expected.receipts[0]);
  receipt.semantic_head.sequence = supportedSequenceMaximum;
  const receiptAtMaximum = await validateAgainstSchemaPath(
    packageRoot,
    'contracts/schemas/semantic-receipt.schema.json',
    receipt,
  );
  receipt.semantic_head.sequence = supportedSequenceMaximum + 1;
  const receiptPastMaximum = await validateAgainstSchemaPath(
    packageRoot,
    'contracts/schemas/semantic-receipt.schema.json',
    receipt,
  );
  assert.deepEqual(receiptAtMaximum, []);
  assert.notEqual(receiptPastMaximum.length, 0);
  const operationPastMaximum = await replayRecords([
    canonicalMarkerRecord(supportedSequenceMaximum + 1),
  ], null, [], packageRoot);
  assert.equal(operationPastMaximum.code, 'semantic.record_malformed');

  const fixture = JSON.parse(await readFile(
    new URL('./scenarios/semantic-kernel/valid-initial-append.json', import.meta.url),
    'utf8',
  ));
  assert.ok(fixture?.subject?.document?.initial?.head !== null &&
    typeof fixture?.subject?.document?.initial?.head === 'object',
  'valid-initial-append.json must supply initial.head');
  assert.ok(fixture?.subject?.document?.action?.ordering !== null &&
    typeof fixture?.subject?.document?.action?.ordering === 'object',
  'valid-initial-append.json must supply action.ordering');
  fixture.subject.document.initial.head.sequence = supportedSequenceMaximum;
  fixture.subject.document.action.ordering.sequence = supportedSequenceMaximum + 1;
  const unsafeFixture = structuredClone(fixture);
  unsafeFixture.subject.document.initial.head.sequence = Number.MAX_SAFE_INTEGER + 0.5;
  unsafeFixture.subject.document.action.ordering.sequence = Number.MAX_SAFE_INTEGER + 0.5;

  const [observed, unsafeObserved] = await Promise.all([
    observeFixture(fixture, packageRoot),
    observeFixture(unsafeFixture, packageRoot),
  ]);

  for (const result of [observed, unsafeObserved]) {
    assert.equal(result.verdict, 'fail');
    assert.deepEqual(result.operations, ['validate Semantic Kernel scenario']);
    assert.ok(result.codes[0].startsWith('schema.'));
  }
});

test('Semantic Snapshot replay continues beyond one batch with equivalent idempotency', async () => {
  const records = markerRecords(66);
  const prefix = await replayRecords(records.slice(0, 2), null, [], packageRoot);
  const full = await replayRecords(records, null, [], packageRoot);
  const observed = await replayFixture(snapshotFromReplay(prefix), records.slice(2));
  const continuedSnapshot = emittedSnapshot(observed);

  assert.equal(observed.verdict, 'pass');
  assert.equal(continuedSnapshot.history.length, 66);
  assert.deepEqual(continuedSnapshot, snapshotFromReplay(full));

  const conflictingRecord = canonicalMarkerRecord(67, 'idempotency:0001');
  const [snapshotConflict, fullConflict] = await Promise.all([
    replayRecords([conflictingRecord], continuedSnapshot, [], packageRoot),
    replayRecords([...records, conflictingRecord], null, [], packageRoot),
  ]);
  assert.equal(snapshotConflict.code, 'semantic.idempotency_incompatible');
  assert.equal(fullConflict.code, snapshotConflict.code);
});

test('Semantic replay rolls back a batch when a later record fails', async () => {
  const records = markerRecords(2);
  const invalid = JSON.parse(records[1]);
  invalid.closure_receipt.state_digest = 'a'.repeat(64);
  invalid.operation_digest = operationDigest(invalid);
  records[1] = `${canonicalJson(invalid)}\n`;

  const result = await replayRecords(records, null, [], packageRoot);

  assert.equal(result.code, 'semantic.receipt_invalid');
  assert.deepEqual(result.head, {sequence: 0, operationId: null});
  assert.deepEqual([...result.state], []);
});

test('Semantic Kernel recovery action branches are total and deterministic', async () => {
  const paths = [
    'crash-before-record-publish-recovery.json',
    'crash-after-record-publish-recovery.json',
    'recovery-while-ready-denied.json',
  ];
  const fixtures = await Promise.all(paths.map(async (path) => JSON.parse(await readFile(
    new URL(`./scenarios/semantic-kernel/${path}`, import.meta.url),
    'utf8',
  ))));

  const observed = await Promise.all(fixtures.map((fixture) => observeFixture(fixture, packageRoot)));
  assert.equal(observed[0].verdict, 'pass');
  assert.equal(observed[1].verdict, 'pass');
  assert.deepEqual(observed[2].codes, ['semantic.recovery_not_required']);

  const invalid = structuredClone(fixtures[0]);
  invalid.subject.document.action.crash_point = null;
  const invalidObserved = await observeFixture(invalid, packageRoot);
  assert.equal(invalidObserved.verdict, 'fail');
  assert.deepEqual(invalidObserved.operations, ['validate Semantic Kernel scenario']);
});

test('recovery receipt schema rejects an impossible after-publish effect pair', async () => {
  const fixture = JSON.parse(await readFile(
    new URL('./scenarios/semantic-kernel/crash-after-record-publish-recovery.json', import.meta.url),
    'utf8',
  ));
  const receipt = JSON.parse(fixture.expected.receipts.at(-1));
  receipt.filesystem_effects = ['discard uncommitted staging record', 'preserve canonical operation'];

  const errors = await validateAgainstSchemaPath(
    packageRoot,
    'contracts/schemas/semantic-receipt.schema.json',
    receipt,
  );

  assert.notEqual(errors.length, 0);
});
