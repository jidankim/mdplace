import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

import {observeFixture} from './fixture-observer.mjs';
import {validateAgainstSchemaPath} from './json-schema.mjs';
import {buildValidationReport} from './validation-report.mjs';
import {checkVaultMutationGateContract} from './vault-mutation-gate-checks.mjs';
import {copyCommittedPackage} from './validator-test-support.mjs';

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
  for (const {allowed_outcomes: allowedOutcomes, mode_results: results} of matrix.boundaries) {
    assert.deepEqual(allowedOutcomes, [...new Set(results.map(({recovery_action: action}) => action))]);
  }
});

test('recovery validates exact descriptor receipt and readback tuples', async () => {
  // Given an otherwise valid recovery scenario whose readback tuple drifted.
  const fixture = await readPackageJson(
    'conformance/scenarios/vault-mutation-gate/before-journal-cancel.json',
  );
  fixture.subject.document.probe.readback_identity.content_sha256 = 'f'.repeat(64);

  // When recovery evaluates the retained-descriptor evidence.
  const observation = await observeFixture(fixture, packageRoot);

  // Then recovery halts instead of accepting the matrix row alone.
  assert.equal(observation.verdict, 'fail');
  assert.deepEqual(observation.codes, ['recovery.evidence_mismatch']);
});

test('recovery evidence binds each boundary-mode row to its exact fixture behavior', async () => {
  // Given a copied package whose first evidence row is repointed to another valid crash fixture.
  const copiedRoot = await copyCommittedPackage();
  const conformance = JSON.parse(await readFile(join(copiedRoot, 'conformance/manifest.yaml'), 'utf8'));
  const recoveryPath = join(copiedRoot, 'conformance/evidence/vault-mutation-recovery-report.json');
  const recovery = JSON.parse(await readFile(recoveryPath, 'utf8'));
  const first = recovery.boundary_mode_results[0];
  const second = recovery.boundary_mode_results[1];
  const secondEntry = conformance.fixtures.find(({fixture_id: fixtureId}) =>
    fixtureId === second.fixture_id);
  const secondBytes = await readFile(join(copiedRoot, 'conformance', secondEntry.path));
  first.fixture_id = second.fixture_id;
  first.fixture_sha256 = createHash('sha256').update(secondBytes).digest('hex');
  await writeFile(recoveryPath, `${JSON.stringify(recovery, null, 2)}\n`);

  // When the contract checker validates the recovery proof.
  const [manifest, traceability] = await Promise.all([
    readFile(join(copiedRoot, 'package-manifest.yaml'), 'utf8').then(JSON.parse),
    readFile(join(copiedRoot, 'traceability.yaml'), 'utf8').then(JSON.parse),
  ]);
  const contract = await checkVaultMutationGateContract(
    copiedRoot,
    manifest,
    conformance,
    traceability,
  );

  // Then fixture reuse cannot stand in for the claimed boundary-mode observation.
  assert.equal(contract.verdict, 'fail');
  assert.ok(contract.codes.includes('vault_mutation.boundary_mode_evidence_invalid'));
});

test('malformed crash recovery rows fail deterministically without throwing', async () => {
  // Given a copied package whose crash matrix contains a non-object mode row.
  const copiedRoot = await copyCommittedPackage();
  const matrixPath = join(copiedRoot, 'contracts/vault-mutation-gate/crash-boundary-matrix.json');
  const matrix = JSON.parse(await readFile(matrixPath, 'utf8'));
  matrix.boundaries[0].mode_results = [null];
  await writeFile(matrixPath, `${JSON.stringify(matrix, null, 2)}\n`);

  // When the full report evaluates both the contract and public recovery fixtures.
  const report = await buildValidationReport(copiedRoot);

  // Then the malformed boundary is contained as a structured contract failure.
  assert.equal(report.verdict, 'fail');
  assert.ok(report.checks.some(({id, verdict}) =>
    id === 'vault-mutation-gate-contract' && verdict === 'fail'));
});
