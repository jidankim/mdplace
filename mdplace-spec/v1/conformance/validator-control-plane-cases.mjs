import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHmac} from 'node:crypto';
import {readFile, unlink, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

import {validateAgainstSchemaPath} from './json-schema.mjs';
import {buildValidationReport} from './validation-report.mjs';
import {observeControlPlaneScenario} from './control-plane-observer.mjs';
import {childWorkInvocationIsValid} from './child-work-validation.mjs';
import {signControlPlaneReceipt} from './control-plane-authentication.mjs';
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

test('transition and recovery inventories pin row semantics, not only identifiers', async () => {
  const transitionRoot = await copyCommittedPackage();
  const transitionPath = `${transitionRoot}/contracts/transitions/retry-lifecycle.json`;
  const transitions = JSON.parse(await readFile(transitionPath));
  const retryTransition = transitions.transitions.find(({transition_id: id}) => id === 'TR-CPRETRY-006');
  retryTransition.terminal_state = 'executing';
  retryTransition.preconditions[0] = 'current tick is before the durable retry-eligibility tick';
  await writeFile(transitionPath, `${JSON.stringify(transitions, null, 2)}\n`);
  const transitionReport = await buildValidationReport(transitionRoot);
  assert.ok(transitionReport.checks.find(({id}) => id === 'control-plane-contract').codes
    .includes('control.transition_inventory_invalid'));

  const recoveryRoot = await copyCommittedPackage();
  const recoveryPath = `${recoveryRoot}/contracts/control-plane/recovery-matrix.json`;
  const recovery = JSON.parse(await readFile(recoveryPath));
  const exhaustedRecovery = recovery.rows.find(({case_id: id}) => id === 'RC-CP-010');
  exhaustedRecovery.default_decision = 'resume';
  exhaustedRecovery.actor_authority.roles = ['vault_owner'];
  exhaustedRecovery.emitted_records = ['ResumeReceipt'];
  await writeFile(recoveryPath, `${JSON.stringify(recovery, null, 2)}\n`);
  const recoveryReport = await buildValidationReport(recoveryRoot);
  assert.ok(recoveryReport.checks.find(({id}) => id === 'control-plane-contract').codes
    .includes('control.recovery_inventory_invalid'));
});

test('retry timing and lease freshness reject early or stale mutations', async () => {
  const failureFixture = JSON.parse(await readFile(new URL('./scenarios/control-plane/first-retry-recorded.json', import.meta.url)));
  const staleFailure = structuredClone(failureFixture.subject);
  staleFailure.document.action.current_tick = staleFailure.document.initial.work.lease_expires_tick;
  const failureResult = await observeControlPlaneScenario(staleFailure, packageRoot);
  assert.deepEqual(failureResult.codes, ['control.lease_stale']);

  const earlyRetry = structuredClone(failureFixture.subject);
  const {initial, action} = earlyRetry.document;
  initial.work = {...initial.work, state: 'retry_wait', retry_count: 1, retry_eligible_tick: 50,
    lease_id: null, lease_status: null, lease_acquired_tick: null, lease_expires_tick: null,
    owner_agent_id: null};
  Object.assign(action, {kind: 'retry', actor_role: 'scheduler', lease_id: 'lease:retry-001', current_tick: 49});
  const retryResult = await observeControlPlaneScenario(earlyRetry, packageRoot);
  assert.deepEqual(retryResult.codes, ['control.retry_not_eligible']);

  const dispatchFixture = JSON.parse(await readFile(new URL('./scenarios/control-plane/dequeue-acknowledges-after-receipt.json', import.meta.url)));
  const secondRetry = structuredClone(dispatchFixture.subject);
  secondRetry.document.initial.work = {...secondRetry.document.initial.work, state: 'retry_wait', retry_count: 2,
    retry_eligible_tick: 50, lease_id: null, lease_status: null, lease_acquired_tick: null,
    lease_expires_tick: null, owner_agent_id: null};
  Object.assign(secondRetry.document.action, {kind: 'retry', actor_role: 'scheduler',
    lease_id: 'lease:retry-002', current_tick: 50});
  const secondRetryResult = await observeControlPlaneScenario(secondRetry, packageRoot);
  assert.equal(secondRetryResult.verdict, 'pass');
  assert.equal(secondRetryResult.terminal_state, 'leased');
});

test('dispatch revalidates current journal writer readiness dependency and capacity evidence', async () => {
  const fixture = JSON.parse(await readFile(new URL('./scenarios/control-plane/dequeue-acknowledges-after-receipt.json', import.meta.url)));
  const mutations = [
    ['control.journal_head_stale', (subject) => { subject.document.action.expected_journal_head_sequence += 1; }],
    ['control.writer_receipt_invalid', (subject) => { subject.document.action.writer_lock_receipt.signature_digest = '0'.repeat(64); }],
    ['control.readiness_sequence_invalid', (subject) => { subject.document.action.readiness_observations[0].signature_digest = '0'.repeat(64); }],
    ['control.dependency_base_stale', (subject) => { subject.document.action.expected_dependency_state_digest = '0'.repeat(64); }],
    ['control.concurrency_budget_exhausted', (subject) => { subject.document.initial.active_work_count = 8; }],
  ];
  for (const [code, mutate] of mutations) {
    const subject = structuredClone(fixture.subject);
    mutate(subject);
    const observed = await observeControlPlaneScenario(subject, packageRoot);
    assert.deepEqual(observed.codes, [code]);
  }
});

test('recovery exhaustion commits an authenticated terminal failure', async () => {
  const fixture = JSON.parse(await readFile(new URL('./scenarios/control-plane/in-flight-work-recovers-agent-crash.json', import.meta.url)));

  const recoveryExhausted = structuredClone(fixture.subject);
  recoveryExhausted.document.initial.work.recovery_interruption_count = 2;
  recoveryExhausted.document.action.interruption_count = 3;
  const recoveryResult = await observeControlPlaneScenario(recoveryExhausted, packageRoot);
  assert.equal(recoveryResult.verdict, 'pass');
  assert.equal(recoveryResult.terminal_state, 'failed');
  assert.equal(recoveryResult.outputs.includes('work_state:failed'), true);
  assert.equal(recoveryResult.filesystem_effects.includes('append durable terminal failure'), true);
  assert.equal(recoveryResult.receipts.includes('TerminalFailureReceipt:work:001'), true);
  assert.equal(recoveryResult.codes.length, 0);

  const retryExhausted = structuredClone(fixture.subject);
  retryExhausted.document.initial.work.retry_count = 2;
  const retryResult = await observeControlPlaneScenario(retryExhausted, packageRoot);
  assert.equal(retryResult.verdict, 'pass');
  assert.equal(retryResult.terminal_state, 'failed');
});

test('idempotent cancellation and readiness lifecycle observations match their matrices', async () => {
  const cancelledFixture = JSON.parse(await readFile(new URL('./scenarios/control-plane/cancelled-work-persists-restart.json', import.meta.url)));
  const cancelled = structuredClone(cancelledFixture.subject);
  Object.assign(cancelled.document.action, {kind: 'cancel', actor_role: 'vault_owner',
    work_id: cancelled.document.initial.work.work_id,
    expected_work_version: cancelled.document.initial.work.work_version});
  const cancellationResult = await observeControlPlaneScenario(cancelled, packageRoot);
  assert.equal(cancellationResult.verdict, 'pass');
  assert.deepEqual(cancellationResult.filesystem_effects, ['none']);
  assert.equal(cancellationResult.outputs.includes('cancellation idempotent'), true);

  const readinessFixture = JSON.parse(await readFile(new URL('./scenarios/control-plane/readiness-work-journal-unavailable.json', import.meta.url)));
  readinessFixture.subject.document.initial.agent_state = 'ready';
  const readinessResult = await observeControlPlaneScenario(readinessFixture.subject, packageRoot);
  assert.deepEqual(readinessResult.codes, ['control.illegal_transition']);
  assert.equal(readinessResult.illegal_transition, true);
});

test('keyed readiness and completion verification rejects recomputed forgeries', async () => {
  const fixture = JSON.parse(await readFile(new URL('./scenarios/control-plane/queued-work-resumes-agent-restart.json', import.meta.url)));
  const forgedReadiness = structuredClone(fixture.subject);
  const gate = forgedReadiness.document.action.readiness_observations[0];
  gate.observation_digest = 'a'.repeat(64);
  gate.signature_digest = createHmac('sha256', 'attacker-controlled-key').update([
    'readiness_gate', gate.receipt_id, gate.agent_id, gate.vault_id, gate.ordinal,
    gate.gate, gate.verdict, gate.observation_digest, gate.previous_receipt_digest,
  ].join('\0')).digest('hex');
  const readinessResult = await observeControlPlaneScenario(forgedReadiness, packageRoot);
  assert.deepEqual(readinessResult.codes, ['control.readiness_sequence_invalid']);

  const child = JSON.parse(await readFile(new URL('../contracts/control-plane/child-work-invocation.json', import.meta.url)));
  child.completion_receipt.signer_agent_id = 'agent:competing-001';
  assert.equal(childWorkInvocationIsValid(child), false);

  const relabeledChild = JSON.parse(await readFile(new URL('../contracts/control-plane/child-work-invocation.json', import.meta.url)));
  relabeledChild.work_binding.persistent_agent_id = 'agent:competing-001';
  relabeledChild.completion_receipt.signer_agent_id = 'agent:competing-001';
  assert.equal(childWorkInvocationIsValid(relabeledChild), false);
});

test('Work Journal terminal results require trusted keyed authentication', async () => {
  const temporaryRoot = await copyCommittedPackage();
  const journalPath = `${temporaryRoot}/contracts/control-plane/work-journal.json`;
  const journal = JSON.parse(await readFile(journalPath));
  const work = journal.work_items[0];
  work.state = 'failed';
  work.result = {
    outcome: 'failed', receipt_id: 'receipt:failed-001', work_version: work.work_version,
    lease_id: null, journal_sequence: journal.head_sequence, output_digest: null,
    code: 'control.retry_ceiling_exceeded',
  };
  Object.assign(work.result, signControlPlaneReceipt('work_completion', [
    work.result.receipt_id, work.work_id, work.result.work_version, '',
    work.result.journal_sequence, work.result.outcome, '', work.result.code,
  ]));
  work.result.signer_agent_id = 'agent:competing-001';
  await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);

  const report = await buildValidationReport(temporaryRoot);
  const controlPlaneCheck = report.checks.find(({id}) => id === 'control-plane-contract');
  assert.ok(controlPlaneCheck.codes.includes('control.work_journal_state_invalid'));
});

test('Work Journal completion binds outcome fields and one unique durable completion entry', async () => {
  async function terminalJournal() {
    const temporaryRoot = await copyCommittedPackage();
    const journalPath = `${temporaryRoot}/contracts/control-plane/work-journal.json`;
    const journal = JSON.parse(await readFile(journalPath));
    const work = journal.work_items[0];
    journal.head_sequence = 2;
    work.state = 'failed';
    work.result = {outcome: 'failed', receipt_id: 'receipt:failed-001', work_version: work.work_version,
      lease_id: null, journal_sequence: 2, output_digest: null, code: 'control.retry_ceiling_exceeded'};
    Object.assign(work.result, signControlPlaneReceipt('work_completion', [
      work.result.receipt_id, work.work_id, work.result.work_version, '',
      work.result.journal_sequence, work.result.outcome, '', work.result.code,
    ]));
    journal.receipts.push({receipt_id: work.result.receipt_id, receipt_kind: 'completion',
      journal_sequence: 2, work_id: work.work_id, work_version: work.work_version,
      state: 'failed', operation_digest: 'a'.repeat(64), semantic_state_digest: 'd'.repeat(64)});
    return {temporaryRoot, journalPath, journal, work};
  }

  const valid = await terminalJournal();
  await writeFile(valid.journalPath, `${JSON.stringify(valid.journal, null, 2)}\n`);
  const validReport = await buildValidationReport(valid.temporaryRoot);
  assert.equal(validReport.checks.find(({id}) => id === 'control-plane-contract').codes
    .includes('control.work_journal_state_invalid'), false);

  const nullSuccess = await terminalJournal();
  nullSuccess.work.state = 'succeeded';
  Object.assign(nullSuccess.work.result, {outcome: 'succeeded', output_digest: null, code: null});
  Object.assign(nullSuccess.work.result, signControlPlaneReceipt('work_completion', [
    nullSuccess.work.result.receipt_id, nullSuccess.work.work_id, nullSuccess.work.result.work_version, '',
    nullSuccess.work.result.journal_sequence, 'succeeded', '', '',
  ]));
  nullSuccess.journal.receipts.at(-1).state = 'succeeded';
  await writeFile(nullSuccess.journalPath, `${JSON.stringify(nullSuccess.journal, null, 2)}\n`);
  const nullReport = await buildValidationReport(nullSuccess.temporaryRoot);
  assert.ok(nullReport.checks.find(({id}) => id === 'control-plane-contract').codes
    .includes('control.work_journal_state_invalid'));

  const collision = await terminalJournal();
  collision.work.result.journal_sequence = 1;
  collision.journal.receipts.at(-1).journal_sequence = 1;
  Object.assign(collision.work.result, signControlPlaneReceipt('work_completion', [
    collision.work.result.receipt_id, collision.work.work_id, collision.work.result.work_version, '',
    1, collision.work.result.outcome, '', collision.work.result.code,
  ]));
  await writeFile(collision.journalPath, `${JSON.stringify(collision.journal, null, 2)}\n`);
  const collisionReport = await buildValidationReport(collision.temporaryRoot);
  assert.ok(collisionReport.checks.find(({id}) => id === 'control-plane-contract').codes
    .includes('control.work_journal_state_invalid'));
});

test('retry eligibility arithmetic remains within the closed tick range', async () => {
  const fixture = JSON.parse(await readFile(new URL('./scenarios/control-plane/first-retry-recorded.json', import.meta.url)));
  const subject = structuredClone(fixture.subject);
  Object.assign(subject.document.initial.work, {lease_acquired_tick: 999698, lease_expires_tick: 999998});
  subject.document.action.current_tick = 999997;
  const observed = await observeControlPlaneScenario(subject, packageRoot);
  assert.equal(observed.verdict, 'pass');
  assert.equal(observed.terminal_state, 'failed');
  assert.equal(observed.outputs.includes('retry eligibility tick overflow produced terminal failure'), true);
  assert.equal(observed.codes.includes('control.post_state_invalid'), false);
});
