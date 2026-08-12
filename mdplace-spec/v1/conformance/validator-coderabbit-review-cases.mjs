import assert from 'node:assert/strict';
import {readFile, unlink, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

import {buildValidationReport} from './validation-report.mjs';
import {validateAgainstSchemaPath, validateJsonSchema} from './json-schema.mjs';
import {checkSemanticKernelContract} from './semantic-kernel-checks.mjs';
import {snapshotHistoryIsCanonical} from './semantic-kernel-core.mjs';
import {copyCommittedPackage} from './validator-test-support.mjs';

const committedPackage = fileURLToPath(new URL('../', import.meta.url));

async function readJson(root, path) {
  return JSON.parse(await readFile(join(root, path), 'utf8'));
}

async function writeJson(root, path, document) {
  await writeFile(join(root, path), `${JSON.stringify(document, null, 2)}\n`);
}

async function semanticContractInputs(packageRoot) {
  return {
    manifest: await readJson(packageRoot, 'package-manifest.yaml'),
    conformance: await readJson(packageRoot, 'conformance/manifest.yaml'),
    traceability: await readJson(packageRoot, 'traceability.yaml'),
  };
}

async function checkContract(packageRoot, inputs) {
  return checkSemanticKernelContract(
    packageRoot,
    inputs.manifest,
    inputs.conformance,
    inputs.traceability,
  );
}

test('JSON Schema maxContains rejects a second matching array entry', () => {
  // Given an array schema permitting exactly one owner entry.
  const schema = {
    type: 'array',
    contains: {type: 'object', properties: {actor_kind: {const: 'vault_owner'}}},
    minContains: 1,
    maxContains: 1,
  };

  // When two entries match the contains schema.
  const errors = validateJsonSchema(schema, [
    {actor_kind: 'vault_owner'},
    {actor_kind: 'vault_owner'},
  ]);

  // Then the upper cardinality violation is reported.
  assert.ok(errors.some(({keyword}) => keyword === 'maxContains'));
});

test('operation-kind registry schema rejects mismatched canonical fields', async () => {
  // Given a registry entry that combines fields from two operation kinds.
  const registry = await readJson(committedPackage, 'contracts/semantic-operation-kinds.json');
  registry.kinds[1].operation_kind = 'semantic_assignment';

  // When the registry is validated against its public schema.
  const errors = await validateAgainstSchemaPath(
    committedPackage,
    'contracts/schemas/semantic-operation-kind-registry.schema.json',
    registry,
  );

  // Then the invalid combination is rejected.
  assert.notEqual(errors.length, 0);
});

test('authority registry schema rejects duplicate identity tuples with different capabilities', async () => {
  // Given two authority rows with one identity tuple and different capabilities.
  const registry = await readJson(committedPackage, 'contracts/semantic-authorities.json');
  registry.authorities[1] = {
    ...registry.authorities[0],
    capabilities: ['append', 'replay'],
  };

  // When the registry is validated against its public schema.
  const errors = await validateAgainstSchemaPath(
    committedPackage,
    'contracts/schemas/semantic-authority-registry.schema.json',
    registry,
  );

  // Then tuple duplication is rejected independently of capabilities.
  assert.notEqual(errors.length, 0);
});

test('Semantic Kernel value schemas accept line terminators and reject lone surrogates', async () => {
  // Given otherwise valid scenarios containing multiline and invalid Unicode values.
  const multiline = await readJson(
    committedPackage,
    'conformance/scenarios/semantic-kernel/valid-initial-append.json',
  );
  multiline.subject.document.action.payload.events[0].payload.value = 'line one\nline two 😀';
  const loneSurrogate = structuredClone(multiline);
  loneSurrogate.subject.document.action.payload.events[0].payload.value = 'invalid \uD800';

  // When both scenario documents cross the schema boundary.
  const [multilineErrors, surrogateErrors] = await Promise.all([
    validateAgainstSchemaPath(committedPackage, multiline.subject.schema, multiline.subject.document),
    validateAgainstSchemaPath(committedPackage, loneSurrogate.subject.schema, loneSurrogate.subject.document),
  ]);

  // Then line terminators remain valid while lone surrogates fail closed.
  assert.deepEqual(multilineErrors, []);
  assert.notEqual(surrogateErrors.length, 0);
});

test('snapshot canonicality contains lone-surrogate canonicalization failures', () => {
  // Given snapshot history whose claimed canonical record contains a lone surrogate.
  const snapshot = {
    sequence: 1,
    operation_id: 'operation:001',
    history_digest: 'a'.repeat(64),
    history: [{
      sequence: 1,
      operation_id: 'operation:001',
      idempotency_key: 'idempotency:001',
      canonical_record: '\uD800',
    }],
  };

  // When snapshot canonicality is evaluated.
  const canonical = snapshotHistoryIsCanonical(snapshot);

  // Then malformed history is rejected without escaping the validation boundary.
  assert.equal(canonical, false);
});

test('Semantic Kernel contract reports an appended operation-kind registry row', async () => {
  // Given the committed package with an extra operation-kind definition.
  const packageRoot = await copyCommittedPackage();
  const registryPath = 'contracts/semantic-operation-kinds.json';
  const registry = await readJson(packageRoot, registryPath);
  registry.kinds.push({...registry.kinds[0], operation_kind: 'future_kind'});
  await writeJson(packageRoot, registryPath, registry);
  const inputs = await semanticContractInputs(packageRoot);

  // When the Semantic Kernel contract is checked.
  const result = await checkContract(packageRoot, inputs);

  // Then the closed registry diagnostic is emitted.
  assert.ok(result.codes.includes('semantic.operation_registry_invalid'));
});

test('Semantic Kernel manifest reports only an invalid fixture identifier', async () => {
  // Given a semantic scenario with an invalid manifest identifier and a valid path.
  const packageRoot = await copyCommittedPackage();
  const inputs = await semanticContractInputs(packageRoot);
  const entry = inputs.conformance.fixtures.find(({fixture_id: id}) => id.startsWith('FIX-SK-'));
  entry.fixture_id = 'INVALID-SK-ID';

  // When the Semantic Kernel contract is checked.
  const result = await checkContract(packageRoot, inputs);

  // Then only the identifier-specific diagnostic is emitted for that pair.
  assert.ok(result.codes.includes('semantic.scenario_manifest_pair_invalid'));
  assert.equal(result.codes.includes('semantic.scenario_path_invalid'), false);
});

test('Semantic Kernel manifest reports only an invalid scenario path', async () => {
  // Given a semantic scenario with a valid identifier and an invalid path.
  const packageRoot = await copyCommittedPackage();
  const inputs = await semanticContractInputs(packageRoot);
  const entry = inputs.conformance.fixtures.find(({fixture_id: id}) => id.startsWith('FIX-SK-'));
  entry.path = 'scenarios/not-semantic.json';

  // When the Semantic Kernel contract is checked.
  const result = await checkContract(packageRoot, inputs);

  // Then only the path-specific diagnostic is emitted for that pair.
  assert.ok(result.codes.includes('semantic.scenario_path_invalid'));
  assert.equal(result.codes.includes('semantic.scenario_manifest_pair_invalid'), false);
});

test('Semantic Kernel contract contains a missing scenario document', async () => {
  // Given a registered semantic fixture without its subject document.
  const packageRoot = await copyCommittedPackage();
  const inputs = await semanticContractInputs(packageRoot);
  const entry = inputs.conformance.fixtures.find(({fixture_id: id}) => id.startsWith('FIX-SK-'));
  const fixturePath = join(packageRoot, 'conformance', entry.path);
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
  delete fixture.subject.document;
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  // When the Semantic Kernel contract is checked.
  const result = await checkContract(packageRoot, inputs);

  // Then malformed input becomes a deterministic schema diagnostic.
  assert.ok(result.codes.includes('schema.constraint'));
});

test('Semantic Kernel contract contains a missing initial head', async () => {
  // Given a registered semantic fixture without its initial semantic head.
  const packageRoot = await copyCommittedPackage();
  const inputs = await semanticContractInputs(packageRoot);
  const entry = inputs.conformance.fixtures.find(({fixture_id: id}) => id.startsWith('FIX-SK-'));
  const fixturePath = join(packageRoot, 'conformance', entry.path);
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
  delete fixture.subject.document.initial.head;
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  // When the Semantic Kernel contract is checked.
  const result = await checkContract(packageRoot, inputs);

  // Then malformed input becomes a deterministic required-field diagnostic.
  assert.ok(result.codes.includes('schema.required_field'));
});

test('validation report treats the Semantic Kernel lifecycle table as required', async () => {
  // Given a package whose required Semantic Kernel lifecycle table is absent.
  const packageRoot = await copyCommittedPackage();
  await unlink(join(packageRoot, 'contracts/transitions/semantic-kernel-lifecycle.json'));

  // When the validation report is built.
  const report = await buildValidationReport(packageRoot);

  // Then the boundary reports the missing required instance.
  const boundary = report.checks.find(({id}) => id === 'boundary-inputs');
  assert.ok(boundary?.codes.includes('schema.instance_missing'));
});

test('Semantic Kernel recovery evidence uses fixture identity terminology', async () => {
  // Given the committed Semantic Kernel recovery evidence.
  const report = await readJson(
    committedPackage,
    'conformance/evidence/semantic-kernel-recovery-report.json',
  );

  // When the report is validated against its public schema.
  const errors = await validateAgainstSchemaPath(
    committedPackage,
    'contracts/schemas/semantic-kernel-recovery-report.schema.json',
    report,
  );

  // Then the fixture-named identity list is accepted without the old alias.
  assert.deepEqual(errors, []);
  assert.equal(Object.hasOwn(report, 'scenario_ids'), false);
});
