import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile, unlink, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

import {validateAgainstSchemaPath} from './json-schema.mjs';
import {buildValidationReport} from './validation-report.mjs';
import {observeControlPlaneScenario} from './control-plane-observer.mjs';
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

test('ready Agent state requires the persistent writer and canonical gate order', async () => {
  const agent = JSON.parse(await readFile(new URL('../contracts/control-plane/agent-state.json', import.meta.url)));
  const reordered = structuredClone(agent);
  [reordered.readiness_gates[0], reordered.readiness_gates[1]] = [reordered.readiness_gates[1], reordered.readiness_gates[0]];
  const schemaErrors = await validateAgainstSchemaPath(packageRoot, 'contracts/schemas/agent-state.schema.json', reordered);
  assert.ok(schemaErrors.some(({keyword}) => keyword === 'const'));

  const temporaryRoot = await copyCommittedPackage();
  agent.writer_lock.owner_agent_id = 'agent:competing-001';
  await writeFile(`${temporaryRoot}/contracts/control-plane/agent-state.json`, `${JSON.stringify(agent, null, 2)}\n`);
  const report = await buildValidationReport(temporaryRoot);
  const controlPlaneCheck = report.checks.find(({id}) => id === 'control-plane-contract');
  assert.ok(controlPlaneCheck.codes.includes('control.agent_state_invalid'));
});

test('Work Journal and Scheduler reject contradictory durable ownership', async () => {
  const temporaryRoot = await copyCommittedPackage();
  const journalPath = `${temporaryRoot}/contracts/control-plane/work-journal.json`;
  const journal = JSON.parse(await readFile(journalPath));
  journal.work_items.push(structuredClone(journal.work_items[0]));
  await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);

  const schedulerPath = `${temporaryRoot}/contracts/control-plane/scheduler-state.json`;
  const scheduler = JSON.parse(await readFile(schedulerPath));
  scheduler.active_leases.push({
    lease_id: 'lease:001', work_id: 'work:001', work_version: 1,
    owner_agent_id: 'agent:primary-001', acquired_tick: 0, expires_tick: 300, status: 'active',
  });
  await writeFile(schedulerPath, `${JSON.stringify(scheduler, null, 2)}\n`);

  const report = await buildValidationReport(temporaryRoot);
  const controlPlaneCheck = report.checks.find(({id}) => id === 'control-plane-contract');
  assert.ok(controlPlaneCheck.codes.includes('control.work_journal_state_invalid'));
  assert.ok(controlPlaneCheck.codes.includes('control.scheduler_state_invalid'));
});

test('actionable Control Commands require an exact durable base', async () => {
  const command = JSON.parse(await readFile(new URL('../contracts/control-plane/control-command.json', import.meta.url)));
  command.command_kind = 'cancel';
  const errors = await validateAgainstSchemaPath(
    packageRoot,
    'contracts/schemas/control-channel-command.schema.json',
    command,
  );
  assert.ok(errors.some(({keyword}) => keyword === 'minItems'));
});

test('restart fails closed on a competing writer or incomplete readiness sequence', async () => {
  const fixture = JSON.parse(await readFile(new URL('./scenarios/control-plane/queued-work-resumes-agent-restart.json', import.meta.url)));
  const competingWriter = structuredClone(fixture.subject);
  competingWriter.document.initial.writer_owner_agent_id = 'agent:competing-001';
  const writerResult = await observeControlPlaneScenario(competingWriter, packageRoot);
  assert.deepEqual(writerResult.codes, ['control.writer_owner_conflict']);

  const failedGate = structuredClone(fixture.subject);
  failedGate.document.action.readiness_observations[3].verdict = 'fail';
  const gateResult = await observeControlPlaneScenario(failedGate, packageRoot);
  assert.deepEqual(gateResult.codes, ['control.readiness_sequence_invalid']);
});

test('recovery rejects stale leases and forged completion receipts', async () => {
  const recoveryFixture = JSON.parse(await readFile(new URL('./scenarios/control-plane/in-flight-work-recovers-agent-crash.json', import.meta.url)));
  recoveryFixture.subject.document.action.lease_id = 'lease:stale';
  const leaseResult = await observeControlPlaneScenario(recoveryFixture.subject, packageRoot);
  assert.deepEqual(leaseResult.codes, ['control.lease_not_recoverable']);

  const completionFixture = JSON.parse(await readFile(new URL('./scenarios/control-plane/completed-work-not-repeated-restart.json', import.meta.url)));
  completionFixture.subject.document.initial.work.completion_receipt.signature_digest = '0'.repeat(64);
  const completionResult = await observeControlPlaneScenario(completionFixture.subject, packageRoot);
  assert.deepEqual(completionResult.codes, ['control.completion_receipt_invalid']);
});

test('recovery evidence binds every validator-owned denied transition row', async () => {
  const temporaryRoot = await copyCommittedPackage();
  const evidencePath = `${temporaryRoot}/conformance/evidence/control-plane-recovery-report.json`;
  const evidence = JSON.parse(await readFile(evidencePath));
  evidence.transition_bindings[0].denied_transition_ids[0] = 'TR-CPWORK-001';
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

  const report = await buildValidationReport(temporaryRoot);
  const controlPlaneCheck = report.checks.find(({id}) => id === 'control-plane-contract');
  assert.ok(controlPlaneCheck.codes.includes('control.evidence_transition_binding_invalid'));
});
