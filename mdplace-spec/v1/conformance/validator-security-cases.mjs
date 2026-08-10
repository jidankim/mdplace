import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, symlink, unlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

import {validateJsonSchema} from './json-schema.mjs';
import {copyCommittedPackage, preparePackage, runPreparedPackage} from './validator-test-support.mjs';

function reportCodes(report) {
  return report.checks.flatMap(({codes}) => codes);
}

test('schema validation rejects inherited property names when the object is closed', () => {
  // Given a closed schema and an own key inherited by ordinary schema objects.
  const schema = {type: 'object', additionalProperties: false, properties: {}};
  const document = JSON.parse('{"constructor": true}');

  // When the public schema validator checks the boundary value.
  const errors = validateJsonSchema(schema, document);

  // Then the inherited name is still an undeclared field.
  assert.ok(errors.some(({keyword}) => keyword === 'additionalProperties'));
});

test('artifact binding rejects a symlink even when its target bytes match', async () => {
  // Given a manifest-bound artifact replaced by a symlink to identical external bytes.
  const packageRoot = await preparePackage({});
  const artifact = join(packageRoot, 'normative/package-contract.md');
  const externalRoot = await mkdtemp(join(tmpdir(), 'mdplace-external-artifact-'));
  const external = join(externalRoot, 'package-contract.md');
  await writeFile(external, await readFile(artifact));
  await unlink(artifact);
  await symlink(external, artifact);

  // When the public validator checks the package.
  const result = runPreparedPackage(packageRoot);

  // Then matching bytes cannot turn an external symlink target into a package artifact.
  assert.equal(result.status, 1);
  assert.ok(reportCodes(JSON.parse(result.stdout)).includes('artifact.path_unsafe'));
});

test('release observation rejects a required slot replaced by a symlink', async () => {
  // Given the committed release target with one required file redirected externally.
  const packageRoot = await copyCommittedPackage();
  const slot = join(packageRoot, 'conformance/release-targets/complete/architecture.md');
  const externalRoot = await mkdtemp(join(tmpdir(), 'mdplace-external-slot-'));
  const external = join(externalRoot, 'architecture.md');
  await writeFile(external, await readFile(slot));
  await unlink(slot);
  await symlink(external, slot);

  // When release conformance observes the required slots.
  const result = runPreparedPackage(packageRoot);

  // Then the positive release oracle fails instead of attesting the symlink.
  const report = JSON.parse(result.stdout);
  assert.equal(result.status, 1);
  assert.deepEqual(report.fixture_results.find(({id}) => id === 'FIX-PKG-POS-005'), {
    id: 'FIX-PKG-POS-005', verdict: 'fail', codes: ['fixture.oracle_mismatch'],
  });
});

test('release observation rejects a claimed-empty target that contains data', async () => {
  // Given a release target that already contains an entry despite its empty reservation claim.
  const packageRoot = await copyCommittedPackage();
  const target = join(packageRoot, 'conformance/release-targets/complete/releases/1.0.0');
  await mkdir(target, {recursive: true});
  await writeFile(join(target, 'occupied.txt'), 'occupied\n');

  // When release conformance evaluates the immutable target evidence.
  const result = runPreparedPackage(packageRoot);

  // Then the release oracle rejects the contradicted availability claim.
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.fixture_results.find(({id}) => id === 'FIX-PKG-POS-005'), {
    id: 'FIX-PKG-POS-005', verdict: 'fail', codes: ['fixture.oracle_mismatch'],
  });
});

test('amendment observation rejects changed source-release bytes', async () => {
  // Given a source release whose manifest-bound artifact changed after its digest was recorded.
  const packageRoot = await copyCommittedPackage();
  const sourceArtifact = join(
    packageRoot,
    'conformance/release-targets/amendment/source/normative/package-contract.md',
  );
  await writeFile(sourceArtifact, 'tampered released source\n');

  // When amendment conformance observes source preservation.
  const result = runPreparedPackage(packageRoot);

  // Then the positive amendment oracle fails instead of accepting the caller's digest assertion.
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.fixture_results.find(({id}) => id === 'FIX-PKG-POS-006'), {
    id: 'FIX-PKG-POS-006', verdict: 'fail', codes: ['fixture.oracle_mismatch'],
  });
});

test('artifact binding rejects files above the public validator size limit', async () => {
  // Given a correctly hashed artifact larger than the validator boundary budget.
  const oversized = 'x'.repeat(1_048_577);
  const packageRoot = await preparePackage({'normative/oversized.md': oversized});

  // When the public validator reads the artifact ledger.
  const result = runPreparedPackage(packageRoot);

  // Then the package fails deterministically before unbounded content is consumed.
  assert.equal(result.status, 1);
  assert.ok(reportCodes(JSON.parse(result.stdout)).includes('artifact.size_limit'));
});

test('package traversal rejects directory depth above the public validator limit', async () => {
  // Given a package containing an adversarially deep directory tree with no additional files.
  const packageRoot = await copyCommittedPackage();
  await mkdir(join(packageRoot, 'conformance', ...Array.from({length: 65}, () => 'nested')), {recursive: true});

  // When the public validator enumerates package artifacts.
  const result = runPreparedPackage(packageRoot);

  // Then traversal terminates at its declared resource boundary.
  assert.equal(result.status, 1);
  assert.ok(reportCodes(JSON.parse(result.stdout)).includes('artifact.count_limit'));
});

test('schema validation terminates a cyclic local reference', () => {
  // Given a schema whose local reference returns to itself.
  const schema = {$ref: '#'};

  // When the public schema validator evaluates the cycle.
  const errors = validateJsonSchema(schema, 'value');

  // Then validation terminates with a resource-bound error.
  assert.ok(errors.some(({keyword}) => keyword === 'resourceLimit'));
});

test('schema validation reports an invalid regular expression without throwing', () => {
  // Given an untrusted schema with a syntactically invalid pattern.
  const schema = {type: 'string', pattern: '('};

  // When the public schema validator evaluates it.
  const errors = validateJsonSchema(schema, 'value');

  // Then the invalid schema remains a deterministic validation error.
  assert.ok(errors.some(({keyword}) => keyword === 'invalidSchema'));
});

test('schema validation enforces required array members expressed with contains', () => {
  // Given the composition keyword used by the package-manifest foundation slots.
  const schema = {type: 'array', allOf: [{contains: {const: 'required-slot'}}]};

  // When the required member is absent.
  const errors = validateJsonSchema(schema, ['different-slot']);

  // Then composition cannot be bypassed by satisfying only the array shape.
  assert.ok(errors.some(({keyword}) => keyword === 'contains'));
});
