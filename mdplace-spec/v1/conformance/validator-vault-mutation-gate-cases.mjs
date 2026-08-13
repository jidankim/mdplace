import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

import {observeFixture} from './fixture-observer.mjs';
import {validateAgainstSchemaPath} from './json-schema.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const validator = fileURLToPath(new URL('./validator.mjs', import.meta.url));

async function readPackageJson(path) {
  return JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), 'utf8'));
}

test('CLI validates the Vault Mutation Gate contract and 88 public fixtures', () => {
  // Given the committed Specification Package and issue #35 conformance boundary.
  const result = spawnSync(process.execPath, [validator, packageRoot], {encoding: 'utf8'});

  // When the public validator evaluates the package and observable fixture oracles.
  const report = JSON.parse(result.stdout);
  const fixtureResults = report.fixture_results.filter(({id}) => id.startsWith('FIX-VMG-'));

  // Then the dedicated contract check and all named plus boundary-mode fixtures pass.
  assert.ok(report.checks.some(({id, verdict}) =>
    id === 'vault-mutation-gate-contract' && verdict === 'pass'));
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fixtureResults.length, 88);
  assert.ok(fixtureResults.every(({verdict}) => verdict === 'pass'));
});

test('Vault Mutation Gate derives caller and operation authority from the plan fields', async () => {
  // Given a schema-valid scenario whose fault label claims no failure.
  const fixture = await readPackageJson('conformance/scenarios/vault-mutation-gate/capture-promotion-commits.json');
  const document = fixture.subject.document;
  delete document.caller_role;
  document.caller = {
    caller_id: 'intelligence-adapter:fixture-001',
    role: 'intelligence_adapter',
  };
  document.operation_declared = true;
  document.fault = 'none';

  // When the observable boundary evaluates the submitted authority.
  const unauthorized = await observeFixture(fixture, packageRoot);
  document.caller = {
    caller_id: 'folder-projection:fixture-001',
    role: 'folder_projection',
  };
  const wrongOperation = await observeFixture(fixture, packageRoot);

  // Then neither a fault label nor a valid role can authorize the wrong operation.
  assert.deepEqual(unauthorized.codes, ['authority.denied']);
  assert.deepEqual(wrongOperation.codes, ['authority.denied']);
  assert.equal(unauthorized.verdict, 'fail');
  assert.equal(wrongOperation.verdict, 'fail');
});

test('Authorized Mutation Plan schema binds caller identity to caller role', async () => {
  // Given an otherwise valid plan with a mismatched caller identity prefix.
  const plan = await readPackageJson('contracts/vault-mutation-gate/authorized-plan.json');
  plan.caller.caller_id = 'capture-adapter:wrong-role';

  // When the closed plan schema validates it.
  const errors = await validateAgainstSchemaPath(
    packageRoot,
    'contracts/schemas/authorized-mutation-plan.schema.json',
    plan,
  );

  // Then the caller-role contradiction is rejected at the boundary.
  assert.ok(errors.length > 0);
});

test('descriptor probe distinguishes exact precondition and post-operation identities', async () => {
  // Given a mutation whose authorized result differs from its precondition.
  const fixture = await readPackageJson('conformance/scenarios/vault-mutation-gate/capture-promotion-commits.json');
  const document = fixture.subject.document;
  assert.notDeepEqual(
    document.probe.expected_precondition_identity,
    document.probe.expected_result_identity,
  );

  // When the retained-descriptor observation compares every exact tuple.
  const observation = await observeFixture(fixture, packageRoot);

  // Then the distinct authorized result is accepted rather than compared to the precondition.
  assert.equal(observation.verdict, 'pass', JSON.stringify(observation));
});

test('crash and recovery evidence covers every boundary-mode pair', async () => {
  // Given the normative crash matrix and its machine-readable recovery report.
  const matrix = await readPackageJson('contracts/vault-mutation-gate/crash-boundary-matrix.json');
  const recovery = await readPackageJson('conformance/evidence/vault-mutation-recovery-report.json');
  const expectedPairs = matrix.boundaries.flatMap(({boundary_id: boundaryId}) =>
    matrix.interruption_modes.map((mode) => `${boundaryId}:${mode}`));
  const matrixPairs = matrix.boundaries.flatMap(({boundary_id: boundaryId, mode_results: results}) =>
    results.map(({mode}) => `${boundaryId}:${mode}`));
  const reportPairs = recovery.boundary_mode_results.map(({boundary_id: boundaryId, mode}) =>
    `${boundaryId}:${mode}`);

  // Then all 64 pairs have one deterministic normative row and one evidence row.
  assert.equal(expectedPairs.length, 64);
  assert.deepEqual(matrixPairs.sort(), expectedPairs.sort());
  assert.deepEqual(reportPairs.sort(), expectedPairs.sort());
  assert.ok(recovery.boundary_mode_results.every((result) =>
    result.verdict === 'pass' && result.duplicate_effect === false &&
    result.pathname_reopened === false && result.console_success_authoritative === false));
  assert.ok(recovery.boundary_mode_results
    .filter(({boundary_id: boundaryId}) => boundaryId === 'after_commit')
    .every(({observed_outcome: outcome, terminal_state: state}) =>
      outcome === 'resume' && state === 'committed'));
});
