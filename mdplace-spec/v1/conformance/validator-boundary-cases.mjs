import assert from 'node:assert/strict';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

import {observeFixture} from './fixture-observer.mjs';
import {runConformance} from './traceability-checks.mjs';
import {validatePackage} from './validator-test-support.mjs';

function reportCodes(report) {
  return report.checks.flatMap(({codes}) => codes);
}

test('CLI returns a deterministic report for a malformed manifest collection', async () => {
  // Given a package manifest whose artifacts value is not an array.
  const result = await validatePackage({'package-manifest.yaml': {artifacts: {path: 'invalid'}}});

  // When the public CLI processes the malformed boundary.
  const report = JSON.parse(result.stdout);

  // Then it fails through the report contract instead of crashing with TypeError.
  assert.equal(result.status, 1);
  assert.equal(report.verdict, 'fail');
  assert.ok(reportCodes(report).includes('schema.constraint'));
});

test('CLI rejects an omitted required contract schema', async () => {
  // Given a candidate package that removes both the schema set and its foundation declaration.
  const result = await validatePackage({
    'package-manifest.yaml': {layout: {required_release_slots: [], candidate_foundation_slots: ['README.md']}},
  });

  // When the public CLI checks required foundation bindings.
  const report = JSON.parse(result.stdout);

  // Then omission is a deterministic non-pass result.
  assert.equal(result.status, 1);
  assert.ok(reportCodes(report).includes('schema.required_artifact'));
});

test('CLI rejects production behavior hidden under an undeclared top-level path', async () => {
  // Given executable product behavior outside the specification package layout.
  const result = await validatePackage({'application/semantic-kernel.mjs': 'export const writesTruth = true;\n'});

  // When the public CLI checks the specification-only boundary.
  const report = JSON.parse(result.stdout);

  // Then path spelling cannot bypass the no-production-code contract.
  assert.equal(result.status, 1);
  assert.ok(reportCodes(report).includes('package.production_code_forbidden'));
});

test('conformance rejects a manifest path that escapes its fixture directories', async () => {
  // Given a manifest entry that resolves outside conformance/fixtures and conformance/scenarios.
  const workspace = await mkdtemp(join(tmpdir(), 'mdplace-conformance-path-'));
  const packageRoot = join(workspace, 'mdplace-spec/v1');
  await mkdir(join(packageRoot, 'conformance'), {recursive: true});
  await writeFile(join(packageRoot, 'outside.json'), JSON.stringify({
    subject: {kind: 'sha256_boundary', value: 'a'.repeat(64)},
    expected: {verdict: 'pass'},
  }));

  // When the conformance runner resolves the hostile entry.
  const outcome = await runConformance(packageRoot, {
    fixtures: [{fixture_id: 'FIX-TST-POS-001', path: '../outside.json', expected_verdict: 'pass'}],
  }, []);

  // Then the path is rejected without consuming the external fixture.
  assert.ok(outcome.check.codes.includes('conformance.path_invalid'));
});

test('artifact observation stops after named-schema failure', async () => {
  // Given a requirements artifact whose collection has the wrong type.
  const packageRoot = new URL('../', import.meta.url).pathname;
  const fixture = {
    subject: {
      kind: 'artifact', schema: 'contracts/schemas/requirements.schema.json',
      document: {$schema: '../contracts/schemas/requirements.schema.json', schema_id: 'mdplace.requirements/v1', package_series: 'mdplace-spec/v1', requirements: 'invalid'},
    },
  };

  // When the fixture observer validates the named boundary.
  const observed = await observeFixture(fixture, packageRoot);

  // Then it returns the schema failure instead of executing collection semantics and throwing.
  assert.equal(observed.verdict, 'fail');
  assert.deepEqual(observed.codes, ['schema.constraint']);
});

test('CLI returns a structured result for a malformed fixture envelope', async () => {
  // Given a listed fixture whose expected oracle is not an object.
  const fixtureId = 'FIX-TST-NEG-001';
  const result = await validatePackage({
    'conformance/manifest.yaml': {
      fixtures: [{fixture_id: fixtureId, path: 'fixtures/malformed.json', expected_verdict: 'fail'}],
    },
    'conformance/fixtures/malformed.json': {fixture_id: fixtureId, expected: null},
  });

  // When the public CLI reaches conformance evaluation, it reports the invalid envelope without collapsing the report.
  const report = JSON.parse(result.stdout);
  assert.equal(result.status, 1);
  assert.ok(!report.checks.some(({codes}) => codes.includes('validator.deterministic_failure')));
  assert.deepEqual(report.fixture_results, [{id: fixtureId, verdict: 'fail', codes: ['fixture.schema_invalid']}]);
});

test('CLI returns a structured result for a malformed traceability record', async () => {
  // Given an untrusted traceability collection containing a non-object record.
  const result = await validatePackage({
    'normative/requirements.json': {requirements: [{id: 'REQ-TST-001'}]},
    'traceability.yaml': {records: [null]},
  });

  // When semantic traceability checks run, the boundary failure remains local to that check.
  const report = JSON.parse(result.stdout);
  assert.equal(result.status, 1);
  assert.ok(!report.checks.some(({codes}) => codes.includes('validator.deterministic_failure')));
  assert.ok(report.checks.find(({id}) => id === 'traceability').codes.includes('schema.constraint'));
});
