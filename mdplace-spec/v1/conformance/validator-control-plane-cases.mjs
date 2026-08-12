import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile, unlink, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

import {validateAgainstSchemaPath} from './json-schema.mjs';
import {buildValidationReport} from './validation-report.mjs';
import {copyCommittedPackage} from './validator-test-support.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const validator = fileURLToPath(new URL('./validator.mjs', import.meta.url));

test('CLI validates exactly 25 stateful control-plane scenarios', () => {
  // Given the committed Specification Package and its control-plane conformance manifest.
  const result = spawnSync(process.execPath, [validator, packageRoot], {encoding: 'utf8'});

  // When the public validator evaluates the package and its observable fixture oracles.
  const report = JSON.parse(result.stdout);
  const controlPlaneResults = report.fixture_results.filter(({id}) => id.startsWith('FIX-CP-'));

  // Then the dedicated contract check and exactly 25 declared stateful scenarios pass.
  assert.ok(report.checks.some(({id, verdict}) => id === 'control-plane-contract' && verdict === 'pass'));
  assert.equal(controlPlaneResults.length, 25);
  assert.ok(controlPlaneResults.every(({verdict}) => verdict === 'pass'));
});

test('control-plane state schemas reject undeclared ambient authority', async () => {
  const journal = JSON.parse(await readFile(new URL('../contracts/control-plane/work-journal.json', import.meta.url)));
  journal.ambient_semantic_authority = 'inferred';

  const errors = await validateAgainstSchemaPath(
    packageRoot,
    'contracts/schemas/work-journal.schema.json',
    journal,
  );

  assert.ok(errors.some(({keyword}) => keyword === 'additionalProperties'));
});

test('control-plane validation requires every lifecycle matrix', async () => {
  const temporaryRoot = await copyCommittedPackage();
  await unlink(`${temporaryRoot}/contracts/transitions/retry-lifecycle.json`);

  const report = await buildValidationReport(temporaryRoot);
  const controlPlaneCheck = report.checks.find(({id}) => id === 'control-plane-contract');

  assert.equal(controlPlaneCheck?.verdict, 'fail');
  assert.ok(controlPlaneCheck.codes.includes('control.transition_missing'));
});

test('control-plane recovery evidence is bound to observed fixture output', async () => {
  const temporaryRoot = await copyCommittedPackage();
  const evidencePath = `${temporaryRoot}/conformance/evidence/control-plane-recovery-report.json`;
  const evidence = JSON.parse(await readFile(evidencePath));
  evidence.fixture_bindings[0].observable_result_sha256 = '0'.repeat(64);
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

  const report = await buildValidationReport(temporaryRoot);
  const controlPlaneCheck = report.checks.find(({id}) => id === 'control-plane-contract');

  assert.equal(controlPlaneCheck?.verdict, 'fail');
  assert.ok(controlPlaneCheck.codes.includes('control.evidence_observable_mismatch'));
});
