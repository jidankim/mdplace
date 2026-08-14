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
import {operationReceiptDigest} from './vault-mutation-digests.mjs';
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

test('Vault Mutation Gate recomputes plan digests instead of trusting consistent echoes', async () => {
  // Given a copied package whose protected plan input and receipt echo are changed together.
  const copiedRoot = await copyCommittedPackage();
  const planPath = join(copiedRoot, 'contracts/vault-mutation-gate/authorized-plan.json');
  const receiptPath = join(copiedRoot, 'contracts/vault-mutation-gate/operation-receipt.json');
  const [plan, receipt, manifest, conformance, traceability] = await Promise.all([
    readFile(planPath, 'utf8').then(JSON.parse),
    readFile(receiptPath, 'utf8').then(JSON.parse),
    readFile(join(copiedRoot, 'package-manifest.yaml'), 'utf8').then(JSON.parse),
    readFile(join(copiedRoot, 'conformance/manifest.yaml'), 'utf8').then(JSON.parse),
    readFile(join(copiedRoot, 'traceability.yaml'), 'utf8').then(JSON.parse),
  ]);
  plan.source_components = ['Tampered', 'other.md'];
  receipt.source_components = ['Tampered', 'other.md'];
  await Promise.all([
    writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`),
    writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`),
  ]);

  // When the contract checker evaluates the declared digest bindings.
  const contract = await checkVaultMutationGateContract(
    copiedRoot,
    manifest,
    conformance,
    traceability,
  );

  // Then changing all visible echoes cannot preserve the immutable plan identity.
  assert.equal(contract.verdict, 'fail');
  assert.ok(contract.codes.includes('vault_mutation.digest_invalid'));
});

test('Vault Mutation Gate rejects a reordered durable journal prefix', async () => {
  // Given a copied committed journal whose interior events violate the normative order.
  const copiedRoot = await copyCommittedPackage();
  const journalPath = join(copiedRoot, 'contracts/vault-mutation-gate/mutation-journal.json');
  const [journal, manifest, conformance, traceability] = await Promise.all([
    readFile(journalPath, 'utf8').then(JSON.parse),
    readFile(join(copiedRoot, 'package-manifest.yaml'), 'utf8').then(JSON.parse),
    readFile(join(copiedRoot, 'conformance/manifest.yaml'), 'utf8').then(JSON.parse),
    readFile(join(copiedRoot, 'traceability.yaml'), 'utf8').then(JSON.parse),
  ]);
  [journal.entries[1].event, journal.entries[2].event] =
    [journal.entries[2].event, journal.entries[1].event];
  await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);

  // When the contract checker replays the durable journal progression.
  const contract = await checkVaultMutationGateContract(
    copiedRoot,
    manifest,
    conformance,
    traceability,
  );

  // Then hash linkage cannot substitute for the required event order.
  assert.equal(contract.verdict, 'fail');
  assert.ok(contract.codes.includes('vault_mutation.journal_order_invalid'));
});

test('Vault Mutation Gate contains malformed digest and journal artifacts', async () => {
  // Given copied contract artifacts that are valid JSON but fail their schemas.
  const copiedRoot = await copyCommittedPackage();
  const planPath = join(copiedRoot, 'contracts/vault-mutation-gate/authorized-plan.json');
  const journalPath = join(copiedRoot, 'contracts/vault-mutation-gate/mutation-journal.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8'));
  journal.entries = [null];
  await Promise.all([
    writeFile(planPath, '{}\n'),
    writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`),
  ]);

  // When the public report evaluates the malformed digest and event-order inputs.
  const report = await buildValidationReport(copiedRoot);

  // Then the package fails deterministically instead of escaping the validator boundary.
  assert.equal(report.verdict, 'fail');
  assert.ok(report.checks.some(({id, verdict}) =>
    id === 'vault-mutation-gate-contract' && verdict === 'fail'));
});

test('Vault Mutation Gate binds the exact scheduled Work Item and Work Lease', async () => {
  // Given a schema-valid receipt that substitutes the scheduled Work Item version.
  const copiedRoot = await copyCommittedPackage();
  const receiptPath = join(copiedRoot, 'contracts/vault-mutation-gate/operation-receipt.json');
  const [receipt, manifest, conformance, traceability] = await Promise.all([
    readFile(receiptPath, 'utf8').then(JSON.parse),
    readFile(join(copiedRoot, 'package-manifest.yaml'), 'utf8').then(JSON.parse),
    readFile(join(copiedRoot, 'conformance/manifest.yaml'), 'utf8').then(JSON.parse),
    readFile(join(copiedRoot, 'traceability.yaml'), 'utf8').then(JSON.parse),
  ]);
  receipt.scheduled_work.work_version += 1;
  receipt.receipt_sha256 = operationReceiptDigest(receipt);
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

  // When the contract checker compares the plan, journal, and receipt bindings.
  const contract = await checkVaultMutationGateContract(
    copiedRoot,
    manifest,
    conformance,
    traceability,
  );

  // Then a different scheduled attempt cannot inherit mutation authority.
  assert.equal(contract.verdict, 'fail');
  assert.ok(contract.codes.includes('vault_mutation.scheduled_work_binding_invalid'));
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
    document.probe.authorized_precondition_identity,
    document.probe.authorized_result_identity,
  );

  // When the retained-descriptor observation compares every exact tuple.
  const observation = await observeFixture(fixture, packageRoot);

  // Then the distinct authorized result is accepted rather than compared to the precondition.
  assert.equal(observation.verdict, 'pass', JSON.stringify(observation));
});

test('descriptor probe derives content identity from closed virtual-vault bytes', async () => {
  // Given a virtual source whose bytes no longer match the authorized precondition.
  const fixture = await readPackageJson('conformance/scenarios/vault-mutation-gate/capture-promotion-commits.json');
  const sourceBytes = 'candidate-v1\n';
  const resultBytes = 'published-v1\n';
  const identity = (bytes) => ({
    device: 42,
    inode: 1001,
    size: Buffer.byteLength(bytes),
    content_sha256: createHash('sha256').update(bytes).digest('hex'),
  });
  fixture.subject.document.probe = {
    virtual_vault: {
      trusted_root: {descriptor_id: 'descriptor:root-001', device: 42, inode: 1},
      source_components: ['Inbox', 'candidate.md'],
      component_kinds: ['directory', 'file'],
      source_descriptor: {
        descriptor_id: 'descriptor:source-001', device: 42, inode: 1001,
        bytes_utf8: 'candidate-v2\n',
      },
      second_observation: {
        descriptor_id: 'descriptor:source-001', device: 42, inode: 1001,
        bytes_utf8: 'candidate-v2\n',
      },
      path_descriptor_after_validation: 'descriptor:source-001',
      target_exists: false,
      result_descriptor: {
        descriptor_id: 'descriptor:source-001', device: 42, inode: 1001,
        bytes_utf8: resultBytes,
      },
      readback_descriptor: {
        descriptor_id: 'descriptor:source-001', device: 42, inode: 1001,
        bytes_utf8: resultBytes,
      },
    },
    authorized_precondition_identity: identity(sourceBytes),
    authorized_result_identity: identity(resultBytes),
    receipt_precondition_identity: identity(sourceBytes),
    receipt_result_identity: identity(resultBytes),
    receipt_echo: 'complete',
    journal_complete: true,
    console_output: 'none',
  };

  // When the observer hashes bytes from the modeled retained descriptor.
  const observation = await observeFixture(fixture, packageRoot);

  // Then caller-supplied tuple equality cannot hide the content change.
  assert.equal(observation.verdict, 'fail');
  assert.deepEqual(observation.codes, ['descriptor.hash_mismatch']);
});

test('Folder Projection serializes apply across distinct plans in one vault', async () => {
  // Given a valid projection plan while a different projection plan is already applying.
  const fixture = await readPackageJson('conformance/scenarios/vault-mutation-gate/folder-projection-commits.json');
  fixture.subject.document.projection_state = {
    state: 'applying',
    active_plan_id: 'mutation-plan:competing-001',
    active_plan_sha256: '7'.repeat(64),
  };

  // When the second plan reaches the vault-scoped mutation boundary.
  const observation = await observeFixture(fixture, packageRoot);

  // Then Agent ownership cannot substitute for cross-plan apply serialization.
  assert.equal(observation.verdict, 'fail');
  assert.deepEqual(observation.codes, ['projection.concurrent_apply_denied']);
  assert.deepEqual(observation.filesystem_effects, ['none']);
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
  fixture.subject.document.probe.virtual_vault.readback_descriptor.bytes_utf8 = 'drifted-readback\n';

  // When recovery evaluates the retained-descriptor evidence.
  const observation = await observeFixture(fixture, packageRoot);

  // Then recovery halts instead of accepting the matrix row alone.
  assert.equal(observation.verdict, 'fail');
  assert.deepEqual(observation.codes, ['recovery.evidence_mismatch']);
});

test('recovery rejects authorization detached from the exact plan', async () => {
  // Given a valid restart scenario with a substituted authorized-plan digest.
  const fixture = await readPackageJson(
    'conformance/scenarios/vault-mutation-gate/before-journal-restart.json',
  );
  fixture.subject.document.authorization.plan_sha256 = 'f'.repeat(64);

  // When foreground recovery presents the detached authorization.
  const observation = await observeFixture(fixture, packageRoot);

  // Then recovery fails closed before selecting a matrix outcome.
  assert.equal(observation.verdict, 'fail');
  assert.deepEqual(observation.codes, ['recovery.authorization_invalid']);
});

test('compensation requires the exact separately authorized compensating plan', async () => {
  // Given a compensation scenario whose effect authorization was substituted.
  const fixture = await readPackageJson(
    'conformance/scenarios/vault-mutation-gate/restart-explicit-compensation.json',
  );
  fixture.subject.document.recovery.compensation_authorization.effect_sha256 = 'f'.repeat(64);

  // When recovery evaluates the proposed compensation.
  const observation = await observeFixture(fixture, packageRoot);

  // Then a boolean-like claim cannot authorize a different compensating effect.
  assert.equal(observation.verdict, 'fail');
  assert.deepEqual(observation.codes, ['recovery.authorization_invalid']);
});

test('repeated interruption reaches manual repair only at the durable budget ceiling', async () => {
  // Given the repeated-interruption scenario immediately below its declared ceiling.
  const fixture = await readPackageJson(
    'conformance/scenarios/vault-mutation-gate/before-journal-repeated-interruption.json',
  );
  fixture.subject.document.recovery.interruption_count = 2;

  // When recovery evaluates the still-available interruption budget.
  const observation = await observeFixture(fixture, packageRoot);

  // Then the operation remains recovery-required rather than claiming exhausted-budget repair.
  assert.equal(observation.verdict, 'fail');
  assert.deepEqual(observation.codes, ['recovery.interruption_budget_remaining']);
  assert.equal(observation.terminal_state, 'recovery_required');
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
