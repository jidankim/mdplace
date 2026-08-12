import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {cp, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

import {observeFixture} from './fixture-observer.mjs';
import {semanticKernelEvidenceCodes} from './semantic-kernel-evidence.mjs';
import {
  baseMatches,
  canonicalJson,
  commandDigestFromAction,
  commandDigestFromOperation,
  snapshotHistoryDigest,
  stateDigest,
} from './semantic-kernel-core.mjs';

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

test('Semantic Kernel recomputes command identity before accepting a compatible retry', async () => {
  const fixture = JSON.parse(await readFile(
    new URL('./scenarios/semantic-kernel/duplicate-compatible-idempotent.json', import.meta.url),
    'utf8',
  ));
  fixture.subject.document.action.payload.events[0].payload.value = 'cat:attacker-selected';

  const observed = await observeFixture(fixture, packageRoot);

  assert.equal(observed.verdict, 'fail');
  assert.deepEqual(observed.codes, ['semantic.command_digest_invalid']);

  fixture.subject.document.action.command_digest = commandDigestFromAction(fixture.subject.document.action);
  const recomputed = await observeFixture(fixture, packageRoot);
  assert.deepEqual(recomputed.codes, ['semantic.idempotency_incompatible']);
});

test('Semantic Kernel verifies the complete OperationCommit digest during replay', async () => {
  const fixture = JSON.parse(await readFile(
    new URL('./scenarios/semantic-kernel/full-replay-snapshot-equivalence.json', import.meta.url),
    'utf8',
  ));
  const operation = JSON.parse(fixture.subject.document.action.records[0]);
  operation.payload.events[0].payload.value = 'cat:tampered';
  operation.idempotency.command_digest = commandDigestFromOperation(operation);
  fixture.subject.document.action.records[0] = `${canonicalJson(operation)}\n`;

  const observed = await observeFixture(fixture, packageRoot);

  assert.deepEqual(observed.codes, ['semantic.operation_digest_invalid']);
});

test('OperationCommit event replay is atomic and payload types fail at the schema boundary', async () => {
  const fixture = JSON.parse(await readFile(
    new URL('./scenarios/semantic-kernel/valid-serialized-second-append.json', import.meta.url),
    'utf8',
  ));
  fixture.subject.document.action.payload.events.push({
    event_id: 'event:002-002',
    ordinal: 1,
    event_kind: 'semantic_removal',
    schema_version: '1.0.0',
    payload: {key: 'note:missing/placement', value: null},
  });
  fixture.subject.document.action.command_digest = commandDigestFromAction(fixture.subject.document.action);

  const observed = await observeFixture(fixture, packageRoot);

  assert.deepEqual(observed.codes, ['semantic.illegal_transition']);
  assert.ok(observed.outputs.includes(
    'semantic_state:[{"key":"note:001/placement","value":"cat:research"}]',
  ));

  fixture.subject.document.action.payload.events[1].payload.value = 'invalid-removal-value';
  const invalidPayload = await observeFixture(fixture, packageRoot);
  assert.deepEqual(invalidPayload.operations, ['validate Semantic Kernel scenario']);
  assert.ok(invalidPayload.codes[0].startsWith('schema.'));
});

test('Semantic Kernel authority binds the complete actor tuple and capability', async () => {
  const appendFixture = JSON.parse(await readFile(
    new URL('./scenarios/semantic-kernel/valid-initial-append.json', import.meta.url),
    'utf8',
  ));
  appendFixture.subject.document.action.actor.actor_id = 'person:attacker-001';
  const replayFixture = JSON.parse(await readFile(
    new URL('./scenarios/semantic-kernel/full-replay-snapshot-equivalence.json', import.meta.url),
    'utf8',
  ));
  replayFixture.subject.document.action.actor = structuredClone(
    JSON.parse(await readFile(
      new URL('./scenarios/semantic-kernel/valid-initial-append.json', import.meta.url),
      'utf8',
    )).subject.document.action.actor,
  );

  const [unknownActor, wrongCapability] = await Promise.all([
    observeFixture(appendFixture, packageRoot),
    observeFixture(replayFixture, packageRoot),
  ]);

  assert.deepEqual(unknownActor.codes, ['semantic.authority_denied']);
  assert.deepEqual(wrongCapability.codes, ['semantic.authority_denied']);
  assert.ok(wrongCapability.outputs.includes('replay rejected'));
});

test('public validator counts every manifest-owned semantic fixture regardless of ID prefix', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'mdplace-semantic-kernel-'));
  try {
    const repositoryCopy = join(temporaryRoot, 'mdplace');
    const packageCopy = join(repositoryCopy, 'mdplace-spec/v1');
    await mkdir(join(repositoryCopy, 'mdplace-spec'), {recursive: true});
    await cp(new URL('../../../CONTEXT.md', import.meta.url), join(repositoryCopy, 'CONTEXT.md'));
    await cp(packageRoot, packageCopy, {recursive: true});
    const manifestPath = join(packageCopy, 'conformance/manifest.yaml');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const semanticEntry = manifest.fixtures.find(({fixture_id: id}) => id === 'FIX-SK-POS-001');
    manifest.fixtures.push({...structuredClone(semanticEntry), fixture_id: 'FIX-OTHER-POS-999'});
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const result = spawnSync(process.execPath, [validator, packageCopy], {encoding: 'utf8'});
    const report = JSON.parse(result.stdout);
    const semanticCheck = report.checks.find(({id}) => id === 'semantic-kernel-contract');

    assert.equal(result.status, 1);
    assert.equal(semanticCheck.verdict, 'fail');
    assert.ok(semanticCheck.codes.includes('semantic.scenario_count_invalid'));
  } finally {
    await rm(temporaryRoot, {recursive: true, force: true});
  }
});

test('full replay and snapshot suffix expose the same complete idempotency-bound snapshot', async () => {
  const [fullReplayFixture, suffixReplayFixture, evidence, manifest] = await Promise.all([
    readFile(new URL('./scenarios/semantic-kernel/full-replay-snapshot-equivalence.json', import.meta.url), 'utf8'),
    readFile(new URL('./scenarios/semantic-kernel/snapshot-suffix-equivalence.json', import.meta.url), 'utf8'),
    readFile(new URL('./evidence/semantic-kernel-recovery-report.json', import.meta.url), 'utf8'),
    readFile(new URL('./manifest.yaml', import.meta.url), 'utf8'),
  ]).then((documents) => documents.map(JSON.parse));

  const [fullReplay, suffixReplay] = await Promise.all([
    observeFixture(fullReplayFixture, packageRoot),
    observeFixture(suffixReplayFixture, packageRoot),
  ]);
  const snapshots = [fullReplay, suffixReplay].map((result) => {
    const output = result.outputs.find((candidate) => candidate.startsWith('semantic_snapshot:'));
    assert.notEqual(output, undefined);
    return JSON.parse(output.slice('semantic_snapshot:'.length));
  });

  assert.deepEqual(snapshots[0], snapshots[1]);
  assert.deepEqual(Object.keys(snapshots[0]), [
    'history',
    'history_digest',
    'operation_id',
    'semantic_state',
    'sequence',
    'state_digest',
  ]);
  assert.equal(snapshots[0].history.length, 2);
  assert.ok(snapshots[0].history.every(({operation_digest: digest}) => /^[a-f0-9]{64}$/.test(digest)));

  evidence.claims.replay_snapshot_equivalence.idempotency_history_sha256 = '0'.repeat(64);
  const semanticEntries = manifest.fixtures.filter(({fixture_id: id}) => id.startsWith('FIX-SK-'));
  const codes = await semanticKernelEvidenceCodes(packageRoot, evidence, semanticEntries);
  assert.ok(codes.includes('semantic.evidence_replay_equivalence_invalid'));
});

test('snapshot replay revalidates canonical prefix records instead of trusting self-hashed history', async () => {
  const fixture = JSON.parse(await readFile(
    new URL('./scenarios/semantic-kernel/snapshot-suffix-equivalence.json', import.meta.url),
    'utf8',
  ));
  fixture.subject.document.action.snapshot.history[0].operation_digest = 'a'.repeat(64);
  fixture.subject.document.action.snapshot.history_digest = snapshotHistoryDigest(
    fixture.subject.document.action.snapshot.history,
  );

  const observed = await observeFixture(fixture, packageRoot);

  assert.deepEqual(observed.codes, ['semantic.snapshot_stale']);
  assert.ok(observed.outputs.includes('semantic_state:[]'));
});

test('JCS boundary rejects lone Unicode surrogates without rejecting scalar Unicode', async () => {
  const fixture = JSON.parse(await readFile(
    new URL('./scenarios/semantic-kernel/valid-initial-append.json', import.meta.url),
    'utf8',
  ));
  const scalarFixture = structuredClone(fixture);
  scalarFixture.subject.document.action.payload.events[0].payload.value = '😀';
  scalarFixture.subject.document.action.command_digest = commandDigestFromAction(scalarFixture.subject.document.action);
  fixture.subject.document.action.payload.events[0].payload.value = '\uDEAD';

  const [observed, scalarObserved] = await Promise.all([
    observeFixture(fixture, packageRoot),
    observeFixture(scalarFixture, packageRoot),
  ]);

  assert.deepEqual(observed.operations, ['validate Semantic Kernel scenario']);
  assert.ok(observed.codes[0].startsWith('schema.'));
  assert.equal(scalarObserved.verdict, 'pass');
  assert.equal(canonicalJson({value: '😀'}), '{"value":"😀"}');
  assert.throws(() => canonicalJson({value: '\uDEAD'}), /lone Unicode surrogates/);
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
