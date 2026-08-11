import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

import {observeFixture} from './fixture-observer.mjs';
import {validateAgainstSchemaPath} from './json-schema.mjs';
import {baseMatches, stateDigest} from './semantic-kernel-core.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const validator = fileURLToPath(new URL('./validator.mjs', import.meta.url));

test('CLI validates exactly 30 stateful Semantic Kernel scenarios', () => {
  // Given the committed Specification Package with its Semantic Kernel conformance manifest.
  const result = spawnSync(process.execPath, [validator, packageRoot], {encoding: 'utf8'});

  // When the public validator evaluates the package and its observable fixture oracles.
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  const semanticKernelResults = report.fixture_results.filter(({id}) => id.startsWith('FIX-SK-'));

  // Then the dedicated contract check and all 30 declared stateful scenarios pass.
  assert.ok(report.checks.some(({id, verdict}) => id === 'semantic-kernel-contract' && verdict === 'pass'));
  assert.equal(semanticKernelResults.length, 30);
  assert.ok(semanticKernelResults.every(({verdict}) => verdict === 'pass'));
});

test('Semantic Kernel append actions reject a nullable append-only identity', async () => {
  const fixture = JSON.parse(await readFile(
    new URL('./scenarios/semantic-kernel/valid-initial-append.json', import.meta.url),
    'utf8',
  ));
  fixture.subject.document.action.command_id = null;

  const observed = await observeFixture(fixture, packageRoot);

  assert.equal(observed.verdict, 'fail');
  assert.deepEqual(observed.operations, ['validate Semantic Kernel scenario']);
});

test('exact base matching rejects duplicate substitution for an ordered input', () => {
  const state = new Map();
  const digestA = 'a'.repeat(64);
  const digestB = 'b'.repeat(64);
  const boundInputs = [{ref_id: 'input:a', digest: digestA}, {ref_id: 'input:b', digest: digestB}];
  const baseReferences = [
    {ordinal: 0, kind: 'semantic_head', sequence: 0, operation_id: null, state_digest: stateDigest(state)},
    {ordinal: 1, kind: 'bound_input', ref_id: 'input:a', digest: digestA},
    {ordinal: 2, kind: 'bound_input', ref_id: 'input:a', digest: digestA},
  ];

  assert.equal(baseMatches(baseReferences, {sequence: 0, operationId: null}, state, boundInputs), false);
});

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
