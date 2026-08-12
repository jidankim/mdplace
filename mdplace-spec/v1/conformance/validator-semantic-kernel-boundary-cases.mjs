import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

import {observeFixture} from './fixture-observer.mjs';
import {validateAgainstSchemaPath} from './json-schema.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));

test('Semantic Kernel rejects duplicate keys in initial and snapshot state', async () => {
  const initialFixture = JSON.parse(await readFile(
    new URL('./scenarios/semantic-kernel/valid-initial-append.json', import.meta.url),
    'utf8',
  ));
  initialFixture.subject.document.initial.semantic_state = [
    {key: 'note:001/placement', value: 'cat:research'},
    {key: 'note:001/placement', value: 'cat:projects'},
  ];
  const snapshotFixture = JSON.parse(await readFile(
    new URL('./scenarios/semantic-kernel/snapshot-suffix-equivalence.json', import.meta.url),
    'utf8',
  ));
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

test('Semantic Kernel sequence counters are closed at the supported maximum', async () => {
  const fixture = JSON.parse(await readFile(
    new URL('./scenarios/semantic-kernel/valid-initial-append.json', import.meta.url),
    'utf8',
  ));
  fixture.subject.document.initial.head.sequence = 4096;
  fixture.subject.document.action.ordering.sequence = 4097;
  const unsafeFixture = structuredClone(fixture);
  unsafeFixture.subject.document.initial.head.sequence = Number.MAX_SAFE_INTEGER + 1;
  unsafeFixture.subject.document.action.ordering.sequence = Number.MAX_SAFE_INTEGER + 1;

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

test('Semantic Snapshot history remains schema-valid beyond one replay batch', async () => {
  const fixture = JSON.parse(await readFile(
    new URL('./scenarios/semantic-kernel/snapshot-suffix-equivalence.json', import.meta.url),
    'utf8',
  ));
  const snapshot = fixture.subject.document.action.snapshot;
  snapshot.history = Array.from({length: 65}, () => structuredClone(snapshot.history[0]));
  snapshot.sequence = snapshot.history.length;

  const errors = await validateAgainstSchemaPath(
    packageRoot,
    fixture.subject.schema,
    fixture.subject.document,
  );

  assert.deepEqual(errors, []);
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
