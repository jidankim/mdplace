import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {validatePackage} from './validator-test-support.mjs';

test('CLI executes a boundary fixture and compares every observable', async () => {
  // Given a deterministic fixture at the exact SHA-256 boundary.
  const fixture = {
    fixture_id: 'FIX-PKG-BND-001',
    subject: {kind: 'sha256_boundary', value: 'a'.repeat(64)},
    expected: {
      verdict: 'pass',
      codes: [],
      outputs: ['digest accepted'],
      operations: ['validate sha256 boundary'],
      receipts: ['ValidationReceipt'],
      filesystem_effects: ['none'],
      terminal_state: 'validated',
      illegal_transition: false,
    },
  };
  const conformance = {
    fixtures: [{fixture_id: fixture.fixture_id, path: 'fixtures/exact.json', expected_verdict: 'pass'}],
  };

  // When the public validator CLI runs the conformance manifest.
  const result = await validatePackage({
    'package-manifest.yaml': {schema_id: 'mdplace.package-manifest/v1'},
    'conformance/manifest.yaml': conformance,
    'conformance/fixtures/exact.json': fixture,
  });

  // Then the fixture passes only when the complete observable oracle matches.
  assert.equal(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.fixture_results, [{id: 'FIX-PKG-BND-001', verdict: 'pass', codes: []}]);
});

test('CLI treats a closed-schema rejection as a passing negative fixture', async () => {
  // Given a fixture whose package-manifest document has one unknown field.
  const fixture = {
    fixture_id: 'FIX-PKG-NEG-001',
    subject: {kind: 'artifact', schema: 'contracts/schemas/package-manifest.schema.json', document: {schema_id: 'mdplace.package-manifest/v1', ambient_authority: 'inferred'}},
    expected: {verdict: 'fail', codes: ['schema.unknown_field'], outputs: ['artifact rejected'], operations: ['parse boundary document', 'validate closed package manifest'], receipts: ['ValidationReceipt'], filesystem_effects: ['none'], terminal_state: 'rejected', illegal_transition: false},
  };
  const conformance = {fixtures: [{fixture_id: fixture.fixture_id, path: 'fixtures/unknown.json', expected_verdict: 'fail'}]};

  // When the public validator CLI runs the negative fixture.
  const result = await validatePackage({
    'package-manifest.yaml': {schema_id: 'mdplace.package-manifest/v1'},
    'conformance/manifest.yaml': conformance,
    'conformance/fixtures/unknown.json': fixture,
  });

  // Then conformance passes because the boundary rejection matches the oracle.
  assert.equal(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.fixture_results, [{id: 'FIX-PKG-NEG-001', verdict: 'pass', codes: []}]);
});

test('CLI rejects in-place mutation of released content', async () => {
  // Given changed bytes targeting the same released version and path.
  const fixture = {
    fixture_id: 'FIX-PKG-NEG-004',
    subject: {kind: 'release_mutation', source_version: '1.0.0', source_digest: 'a'.repeat(64), source_digest_after_attempt: 'a'.repeat(64), source_path: 'releases/1.0.0', target_version: '1.0.0', target_digest: 'b'.repeat(64), target_path: 'releases/1.0.0'},
    expected: {verdict: 'fail', codes: ['release.immutable'], outputs: ['release mutation rejected'], operations: ['compare version and path bindings'], receipts: ['PackageTransitionDenied', 'VersionAmendmentReport'], filesystem_effects: ['preserve released source byte-for-byte'], terminal_state: 'released', illegal_transition: true},
  };
  const conformance = {fixtures: [{fixture_id: fixture.fixture_id, path: 'fixtures/mutation.json', expected_verdict: 'fail'}]};

  // When the public validator CLI evaluates the requested mutation.
  const result = await validatePackage({
    'package-manifest.yaml': {schema_id: 'mdplace.package-manifest/v1'},
    'conformance/manifest.yaml': conformance,
    'conformance/fixtures/mutation.json': fixture,
  });

  // Then the source is preserved and the negative fixture passes.
  assert.equal(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.fixture_results, [{id: 'FIX-PKG-NEG-004', verdict: 'pass', codes: []}]);
});

test('CLI rejects an amendment version downgrade', async () => {
  // Given a different target path whose version precedes the immutable source release.
  const fixture = {
    fixture_id: 'FIX-PKG-NEG-011',
    subject: {kind: 'release_mutation', source_version: '2.0.0', source_digest: 'a'.repeat(64), source_digest_after_attempt: 'a'.repeat(64), source_path: 'releases/2.0.0', target_version: '1.0.0', target_digest: 'b'.repeat(64), target_path: 'releases/1.0.0'},
    expected: {verdict: 'fail', codes: ['release.immutable'], outputs: ['release mutation rejected'], operations: ['compare version and path bindings'], receipts: ['PackageTransitionDenied', 'VersionAmendmentReport'], filesystem_effects: ['preserve released source byte-for-byte'], terminal_state: 'released', illegal_transition: true},
  };
  const conformance = {fixtures: [{fixture_id: fixture.fixture_id, path: 'fixtures/downgrade.json', expected_verdict: 'fail'}]};

  // When the public validator evaluates the attempted downgrade.
  const result = await validatePackage({
    'package-manifest.yaml': {},
    'conformance/manifest.yaml': conformance,
    'conformance/fixtures/downgrade.json': fixture,
  });

  // Then only a strictly greater version can open a Package Amendment.
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.fixture_results, [{id: fixture.fixture_id, verdict: 'pass', codes: []}]);
});

test('CLI rejects an amendment version with a leading-zero component', async () => {
  // Given a numerically greater target whose spelling is not canonical SemVer.
  const fixture = {
    fixture_id: 'FIX-PKG-NEG-014',
    subject: {kind: 'release_mutation', source_version: '1.0.0', source_digest: 'a'.repeat(64), source_digest_after_attempt: 'a'.repeat(64), source_path: 'releases/1.0.0', target_version: '1.01.0', target_digest: 'b'.repeat(64), target_path: 'releases/1.01.0'},
    expected: {verdict: 'fail', codes: ['release.immutable'], outputs: ['release mutation rejected'], operations: ['compare version and path bindings'], receipts: ['PackageTransitionDenied', 'VersionAmendmentReport'], filesystem_effects: ['preserve released source byte-for-byte'], terminal_state: 'released', illegal_transition: true},
  };
  const conformance = {fixtures: [{fixture_id: fixture.fixture_id, path: 'fixtures/invalid-semver.json', expected_verdict: 'fail'}]};

  // When the public validator evaluates the malformed amendment version.
  const result = await validatePackage({
    'package-manifest.yaml': {},
    'conformance/manifest.yaml': conformance,
    'conformance/fixtures/invalid-semver.json': fixture,
  });

  // Then noncanonical SemVer cannot open a Package Amendment.
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.fixture_results, [{id: fixture.fixture_id, verdict: 'pass', codes: []}]);
});

test('CLI recovers an unverified partial amendment without changing its source', async () => {
  // Given a crash after a target directory exists but before verification or publication.
  const fixture = {
    fixture_id: 'FIX-PKG-REC-001',
    subject: {kind: 'recovery', source_state: 'released', source_digest: 'a'.repeat(64), crash_point: 'after_target_directory_created', target_artifacts_verified: false, target_published: false, partial_target_exists: true},
    expected: {verdict: 'pass', codes: [], outputs: ['source release preserved', 'partial target removed'], operations: ['verify source digest', 'inspect staged target', 'discard unverified partial target'], receipts: ['PackageRecoveryReport'], filesystem_effects: ['preserve released source byte-for-byte', 'remove unverified partial target'], terminal_state: 'released', illegal_transition: false},
  };
  const conformance = {fixtures: [{fixture_id: fixture.fixture_id, path: 'scenarios/recovery.json', expected_verdict: 'pass'}]};

  // When the public validator CLI reconciles the recorded crash point.
  const result = await validatePackage({
    'package-manifest.yaml': {schema_id: 'mdplace.package-manifest/v1'},
    'conformance/manifest.yaml': conformance,
    'conformance/scenarios/recovery.json': fixture,
  });

  // Then recovery preserves the immutable source and removes only the partial target.
  assert.equal(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.fixture_results, [{id: 'FIX-PKG-REC-001', verdict: 'pass', codes: []}]);
});

test('CLI rejects requirement vocabulary absent from the canonical glossary', async () => {
  // Given a schema-valid requirement that names a noncanonical term.
  const fixture = {
    fixture_id: 'FIX-PKG-NEG-006',
    subject: {kind: 'artifact', schema: 'contracts/schemas/requirements.schema.json', document: {requirements: [{id: 'REQ-PKG-005', canonical_terms: ['Mutable Specification Folder']}]}},
    expected: {verdict: 'fail', codes: ['vocabulary.unknown_term'], outputs: ['artifact rejected'], operations: ['parse boundary document', 'validate stable requirement identifiers'], receipts: ['ValidationReceipt'], filesystem_effects: ['none'], terminal_state: 'rejected', illegal_transition: false},
  };
  const conformance = {fixtures: [{fixture_id: fixture.fixture_id, path: 'fixtures/vocabulary.json', expected_verdict: 'fail'}]};

  // When the public validator CLI resolves terms against CONTEXT.md.
  const result = await validatePackage({
    'package-manifest.yaml': {schema_id: 'mdplace.package-manifest/v1'},
    'conformance/manifest.yaml': conformance,
    'conformance/fixtures/vocabulary.json': fixture,
  });

  // Then the unknown term is rejected and the negative fixture passes.
  assert.equal(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.fixture_results, [{id: 'FIX-PKG-NEG-006', verdict: 'pass', codes: []}]);
});

test('CLI rejects a traceability map that omits a normative requirement', async () => {
  // Given two declared requirements but a traceability map containing only one record.
  const fixture = {
    fixture_id: 'FIX-PKG-NEG-007',
    subject: {kind: 'artifact', schema: 'contracts/schemas/traceability.schema.json', document: {records: [{requirement_id: 'REQ-PKG-001'}]}},
    expected: {verdict: 'fail', codes: ['traceability.untraced_requirement'], outputs: ['artifact rejected'], operations: ['parse boundary document', 'validate total traceability'], receipts: ['ValidationReceipt'], filesystem_effects: ['none'], terminal_state: 'rejected', illegal_transition: false},
  };
  const conformance = {fixtures: [{fixture_id: fixture.fixture_id, path: 'fixtures/traceability.json', expected_verdict: 'fail'}]};

  // When the public validator CLI compares the map with the requirement index.
  const result = await validatePackage({
    'package-manifest.yaml': {schema_id: 'mdplace.package-manifest/v1'},
    'normative/requirements.json': {requirements: [{id: 'REQ-PKG-001'}, {id: 'REQ-PKG-002'}]},
    'conformance/manifest.yaml': conformance,
    'conformance/fixtures/traceability.json': fixture,
  });

  // Then the missing binding is rejected and the negative fixture passes.
  assert.equal(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.fixture_results, [{id: 'FIX-PKG-NEG-007', verdict: 'pass', codes: []}]);
});

test('CLI rejects production runtime code from the specification package', async () => {
  // Given an otherwise closed package manifest that declares a runtime implementation artifact.
  const document = {
    $schema: 'contracts/schemas/package-manifest.schema.json',
    schema_id: 'mdplace.package-manifest/v1',
    package_series: 'mdplace-spec/v1',
    release_version: '1.0.0',
    lifecycle_state: 'candidate',
    validator_version: '1.0.0',
    normative_vocabulary: '../../CONTEXT.md',
    authority: {},
    layout: {},
    artifacts: [{path: 'runtime/semantic-kernel.mjs'}],
    normative_digest: 'a'.repeat(64),
    amendment_policy: {},
    conformance: {},
  };
  const fixture = {
    fixture_id: 'FIX-PKG-NEG-008',
    subject: {kind: 'artifact', schema: 'contracts/schemas/package-manifest.schema.json', document},
    expected: {verdict: 'fail', codes: ['package.production_code_forbidden'], outputs: ['artifact rejected'], operations: ['parse boundary document', 'validate closed package manifest'], receipts: ['ValidationReceipt'], filesystem_effects: ['none'], terminal_state: 'rejected', illegal_transition: false},
  };
  const conformance = {fixtures: [{fixture_id: fixture.fixture_id, path: 'fixtures/production.json', expected_verdict: 'fail'}]};

  // When the public validator CLI validates package scope.
  const result = await validatePackage({
    'package-manifest.yaml': {schema_id: 'mdplace.package-manifest/v1'},
    'conformance/manifest.yaml': conformance,
    'conformance/fixtures/production.json': fixture,
  });

  // Then conformance rejects the runtime artifact without invoking it.
  assert.equal(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.fixture_results, [{id: 'FIX-PKG-NEG-008', verdict: 'pass', codes: []}]);
});

test('CLI validates an artifact fixture with its complete named schema', async () => {
  // Given a closed package-shaped document whose constant identities are all false.
  const packageSchema = JSON.parse(await readFile(
    new URL('../contracts/schemas/package-manifest.schema.json', import.meta.url),
    'utf8',
  ));
  const document = {
    $schema: 'contracts/schemas/package-manifest.schema.json',
    schema_id: 'not-mdplace',
    package_series: 'not-mdplace',
    release_version: '1.0.0',
    lifecycle_state: 'candidate',
    validator_version: '1.0.0',
    normative_vocabulary: 'local-glossary.md',
    authority: {normative_rule: 'binding', informative_rule: 'nonbinding', conflict_result: 'informative_ignored_for_conformance'},
    layout: {required_release_slots: Array.from({length: 15}, (_, index) => `slot-${index}`), candidate_foundation_slots: ['README.md']},
    artifacts: [{path: 'README.md', authority: 'informative', media_type: 'text/markdown', sha256: 'a'.repeat(64)}],
    normative_digest: 'b'.repeat(64),
    amendment_policy: {immutable_after_release: true, in_place_mutation: 'forbidden', new_version_required: true, previous_release: null},
    conformance: {manifest: 'conformance/manifest.yaml', validator: 'conformance/validator.mjs', report: 'conformance/evidence/validation-report.json'},
  };
  const fixture = {
    fixture_id: 'FIX-PKG-NEG-099',
    subject: {kind: 'artifact', schema: 'contracts/schemas/package-manifest.schema.json', document},
    expected: {verdict: 'fail', codes: ['schema.constraint'], outputs: ['artifact rejected'], operations: ['parse boundary document', 'validate closed package manifest'], receipts: ['ValidationReceipt'], filesystem_effects: ['none'], terminal_state: 'rejected', illegal_transition: false},
  };
  const conformance = {fixtures: [{fixture_id: fixture.fixture_id, path: 'fixtures/schema-constraint.json', expected_verdict: 'fail'}]};

  // When the fixture oracle names the package schema, every declared constraint is applied.
  const result = await validatePackage({
    'package-manifest.yaml': {},
    'contracts/schemas/package-manifest.schema.json': packageSchema,
    'conformance/manifest.yaml': conformance,
    'conformance/fixtures/schema-constraint.json': fixture,
  });

  // Then valid field names cannot bypass invalid constants.
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.fixture_results, [{id: 'FIX-PKG-NEG-099', verdict: 'pass', codes: []}]);
});
