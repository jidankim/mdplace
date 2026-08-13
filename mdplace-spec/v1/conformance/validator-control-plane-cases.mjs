import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash, createHmac} from 'node:crypto';
import {readFile, unlink, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

import {validateAgainstSchemaPath} from './json-schema.mjs';
import {buildValidationReport} from './validation-report.mjs';
import {observeControlPlaneScenario} from './control-plane-observer.mjs';
import {childWorkInvocationIsValid} from './child-work-validation.mjs';
import {signControlPlaneReceipt} from './control-plane-authentication.mjs';
import {copyCommittedPackage} from './validator-test-support.mjs';
import {canonicalJson} from './semantic-kernel-core.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const validator = fileURLToPath(new URL('./validator.mjs', import.meta.url));

function workJournalHeadDigest(receipts) {
  return createHash('sha256').update(canonicalJson([...receipts]
    .sort((left, right) => left.journal_sequence - right.journal_sequence))).digest('hex');
}

function schedulerStateDigest(activeLeaseIds, maxConcurrentWork = 8) {
  return createHash('sha256').update(canonicalJson({
    active_lease_ids: [...activeLeaseIds].sort(),
    max_concurrent_work: maxConcurrentWork,
  })).digest('hex');
}

function journalCancellationFields(cancellation) {
  return [cancellation.receipt_id, cancellation.cancellation_id, cancellation.work_id,
    cancellation.work_version, cancellation.idempotency_key, cancellation.requested_by,
    cancellation.vault_owner_receipt.receipt_id, cancellation.vault_owner_receipt.signature_digest,
    cancellation.journal_sequence, cancellation.reason_code, cancellation.resume_count,
    cancellation.resume_ceiling];
}

function journalHeadFields(receipt) {
  return [receipt.receipt_id, receipt.journal_id, receipt.head_sequence, receipt.head_digest];
}

function completionFields(receipt) {
  return [receipt.receipt_id, receipt.work_id, receipt.work_version, receipt.lease_id ?? '',
    receipt.journal_sequence, receipt.outcome, receipt.output_digest ?? '', receipt.code ?? ''];
}

function resumeFields(receipt) {
  return [receipt.receipt_id, receipt.work_id, receipt.cancelled_work_version,
    receipt.resumed_work_version, receipt.idempotency_key, receipt.cancellation_receipt_id,
    receipt.resume_count, receipt.journal_sequence];
}

function vaultOwnerFields(receipt) {
  return [receipt.receipt_id, receipt.principal_id, receipt.vault_id, receipt.action_kind,
    receipt.work_id, receipt.work_version, receipt.lease_id ?? '', receipt.idempotency_key];
}

function commandPayloadDigest(command) {
  return createHash('sha256').update(canonicalJson({
    command_kind: command.command_kind,
    command_version: command.command_version,
    idempotency_key: command.idempotency_key,
    base_references: command.base_references,
  })).digest('hex');
}

function authenticateVaultOwnerAction(subject) {
  const {action, initial} = subject.document;
  Object.assign(initial.control_channel, {state: 'open', same_user_authenticated: true, local_transport: true});
  action.vault_owner_receipt = {
    receipt_id: `vault-owner-receipt:${action.kind}-${action.work_id.slice(5)}`,
    principal_id: 'person:owner-001', vault_id: initial.control_channel.vault_id,
    action_kind: action.kind, work_id: action.work_id, work_version: action.expected_work_version,
    lease_id: action.lease_id,
    idempotency_key: action.idempotency_key,
  };
  Object.assign(action.vault_owner_receipt, signControlPlaneReceipt(
    'vault_owner_authorization', vaultOwnerFields(action.vault_owner_receipt),
  ));
}

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

test('Scheduler state is exactly correlated with the Agent and committed Work Journal', async () => {
  const mutations = [
    (scheduler) => { scheduler.journal_head_sequence += 1; },
    (scheduler) => { scheduler.journal_head_digest = '0'.repeat(64); },
    (scheduler) => { scheduler.eligible_queue[0].work_version += 1; },
    (scheduler) => { scheduler.eligible_queue[0].input_digest = '0'.repeat(64); },
    (scheduler) => { scheduler.agent_id = 'agent:competing-001'; },
  ];
  for (const mutate of mutations) {
    const temporaryRoot = await copyCommittedPackage();
    const schedulerPath = `${temporaryRoot}/contracts/control-plane/scheduler-state.json`;
    const scheduler = JSON.parse(await readFile(schedulerPath));
    mutate(scheduler);
    await writeFile(schedulerPath, `${JSON.stringify(scheduler, null, 2)}\n`);
    const report = await buildValidationReport(temporaryRoot);
    assert.ok(report.checks.find(({id}) => id === 'control-plane-contract').codes
      .includes('control.scheduler_state_invalid'));
  }

  for (const pairedRelabel of [false, true]) {
    const temporaryRoot = await copyCommittedPackage();
    const journalPath = `${temporaryRoot}/contracts/control-plane/work-journal.json`;
    const schedulerPath = `${temporaryRoot}/contracts/control-plane/scheduler-state.json`;
    const journal = JSON.parse(await readFile(journalPath));
    const scheduler = JSON.parse(await readFile(schedulerPath));
    journal.vault_id = 'vault:other-001';
    if (pairedRelabel) scheduler.vault_id = journal.vault_id;
    await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
    await writeFile(schedulerPath, `${JSON.stringify(scheduler, null, 2)}\n`);
    const report = await buildValidationReport(temporaryRoot);
    assert.ok(report.checks.find(({id}) => id === 'control-plane-contract').codes
      .includes('control.scheduler_state_invalid'));
  }
});

test('actionable Control Commands validate and require an exact durable base', async () => {
  const command = JSON.parse(await readFile(new URL('../contracts/control-plane/control-command.json', import.meta.url)));
  command.command_kind = 'cancel';
  const errors = await validateAgainstSchemaPath(
    packageRoot,
    'contracts/schemas/control-channel-command.schema.json',
    command,
  );
  assert.ok(errors.some(({keyword}) => keyword === 'minItems'));

  const journal = JSON.parse(await readFile(new URL('../contracts/control-plane/work-journal.json', import.meta.url)));
  const work = journal.work_items[0];
  const cases = [
    ['cancel', {kind: 'work_item', reference_id: work.work_id, version: work.work_version,
      digest: createHash('sha256').update(canonicalJson(work)).digest('hex')}],
    ['enqueue', {kind: 'work_journal', reference_id: journal.journal_id, version: journal.head_sequence,
      digest: journal.head_digest}],
  ];
  for (const [kind, base] of cases) {
    const exact = structuredClone(command);
    exact.command_kind = kind;
    exact.base_references = [base];
    exact.payload_digest = commandPayloadDigest(exact);
    assert.deepEqual(await validateAgainstSchemaPath(
      packageRoot, 'contracts/schemas/control-channel-command.schema.json', exact,
    ), []);

    const staleExtraBase = structuredClone(exact);
    staleExtraBase.base_references.push({
      kind: 'semantic_head', reference_id: 'semantic:head-001', version: 999,
      digest: '0'.repeat(64),
    });
    staleExtraBase.payload_digest = commandPayloadDigest(staleExtraBase);
    assert.ok((await validateAgainstSchemaPath(
      packageRoot, 'contracts/schemas/control-channel-command.schema.json', staleExtraBase,
    )).some(({keyword}) => keyword === 'maxItems'));

    const temporaryRoot = await copyCommittedPackage();
    const commandPath = `${temporaryRoot}/contracts/control-plane/control-command.json`;
    await writeFile(commandPath, `${JSON.stringify(exact, null, 2)}\n`);
    const validReport = await buildValidationReport(temporaryRoot);
    assert.equal(validReport.checks.find(({id}) => id === 'control-plane-contract').codes
      .includes('control.command_state_invalid'), false);

    exact.base_references[0].version += 1;
    exact.payload_digest = commandPayloadDigest(exact);
    await writeFile(commandPath, `${JSON.stringify(exact, null, 2)}\n`);
    const staleReport = await buildValidationReport(temporaryRoot);
    assert.ok(staleReport.checks.find(({id}) => id === 'control-plane-contract').codes
      .includes('control.command_state_invalid'));
  }

  const wrongVaultRoot = await copyCommittedPackage();
  const wrongVaultPath = `${wrongVaultRoot}/contracts/control-plane/control-command.json`;
  const wrongVault = JSON.parse(await readFile(wrongVaultPath));
  wrongVault.vault_id = 'vault:other-001';
  wrongVault.peer.vault_scope = wrongVault.vault_id;
  await writeFile(wrongVaultPath, `${JSON.stringify(wrongVault, null, 2)}\n`);
  const wrongVaultReport = await buildValidationReport(wrongVaultRoot);
  assert.ok(wrongVaultReport.checks.find(({id}) => id === 'control-plane-contract').codes
    .includes('control.command_state_invalid'));

  const relabeledRoot = await copyCommittedPackage();
  const relabeledPath = `${relabeledRoot}/contracts/control-plane/control-command.json`;
  const relabeled = JSON.parse(await readFile(relabeledPath));
  relabeled.command_kind = 'doctor';
  await writeFile(relabeledPath, `${JSON.stringify(relabeled, null, 2)}\n`);
  const relabeledReport = await buildValidationReport(relabeledRoot);
  assert.ok(relabeledReport.checks.find(({id}) => id === 'control-plane-contract').codes
    .includes('control.command_state_invalid'));

  const replayRoot = await copyCommittedPackage();
  const replayPath = `${replayRoot}/contracts/control-plane/control-command.json`;
  const replay = JSON.parse(await readFile(replayPath));
  replay.command_kind = 'enqueue';
  replay.idempotency_key = work.idempotency_key;
  replay.base_references = [{kind: 'work_journal', reference_id: journal.journal_id,
    version: work.enqueue_receipt.base_head_sequence, digest: work.enqueue_receipt.base_head_digest}];
  replay.payload_digest = commandPayloadDigest(replay);
  await writeFile(replayPath, `${JSON.stringify(replay, null, 2)}\n`);
  const replayReport = await buildValidationReport(replayRoot);
  assert.equal(replayReport.checks.find(({id}) => id === 'control-plane-contract').codes
    .includes('control.command_state_invalid'), false);

  replay.base_references[0].version = journal.head_sequence;
  replay.base_references[0].digest = journal.head_digest;
  replay.payload_digest = commandPayloadDigest(replay);
  await writeFile(replayPath, `${JSON.stringify(replay, null, 2)}\n`);
  const currentBaseReplayReport = await buildValidationReport(replayRoot);
  assert.ok(currentBaseReplayReport.checks.find(({id}) => id === 'control-plane-contract').codes
    .includes('control.command_state_invalid'));
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
  completionFixture.subject.document.initial.work.completion_history.at(-1).signature_digest = '0'.repeat(64);
  const completionResult = await observeControlPlaneScenario(completionFixture.subject, packageRoot);
  assert.deepEqual(completionResult.codes, ['control.completion_receipt_invalid']);

  const leaseFixture = JSON.parse(await readFile(new URL('./scenarios/control-plane/completed-work-not-repeated-restart.json', import.meta.url)));
  leaseFixture.subject.document.initial.prior_lease_receipts[0].signature_digest = '0'.repeat(64);
  assert.deepEqual((await observeControlPlaneScenario(leaseFixture.subject, packageRoot)).codes,
    ['control.completion_receipt_invalid']);
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

  const nonretryable = JSON.parse(await readFile(new URL('./scenarios/control-plane/first-retry-recorded.json', import.meta.url)));
  nonretryable.subject.document.action.retryable = false;
  const nonretryableResult = await observeControlPlaneScenario(nonretryable.subject, packageRoot);
  assert.equal(nonretryableResult.verdict, 'pass');
  assert.equal(nonretryableResult.outputs.includes('execution failure produced terminal failure'), true);
  assert.equal(nonretryableResult.outputs.includes('retry ceiling produced terminal failure'), false);
});

test('dispatch revalidates current journal writer readiness dependency and capacity evidence', async () => {
  const fixture = JSON.parse(await readFile(new URL('./scenarios/control-plane/dequeue-acknowledges-after-receipt.json', import.meta.url)));
  const mutations = [
    ['control.journal_head_stale', (subject) => { subject.document.action.expected_journal_head_sequence += 1; }],
    ['control.journal_head_stale', (subject) => { subject.document.action.expected_journal_head_digest = '0'.repeat(64); }],
    ['control.journal_evidence_invalid', (subject) => {
      subject.document.initial.journal_head_digest = '0'.repeat(64);
      subject.document.action.expected_journal_head_digest = '0'.repeat(64);
    }],
    ['control.writer_receipt_invalid', (subject) => { subject.document.action.writer_lock_receipt.signature_digest = '0'.repeat(64); }],
    ['control.readiness_sequence_invalid', (subject) => { subject.document.action.readiness_observations[0].signature_digest = '0'.repeat(64); }],
    ['control.dependency_base_stale', (subject) => { subject.document.action.expected_dependency_state_digest = '0'.repeat(64); }],
    ['control.dependency_evidence_invalid', (subject) => {
      subject.document.initial.dependency_state_digest = '0'.repeat(64);
      subject.document.action.expected_dependency_state_digest = '0'.repeat(64);
    }],
    ['control.scheduler_base_stale', (subject) => { subject.document.initial.active_work_count = 1; }],
    ['control.scheduler_base_stale', (subject) => { subject.document.action.expected_scheduler_state_digest = '0'.repeat(64); }],
    ['control.concurrency_budget_exhausted', (subject) => {
      subject.document.initial.active_lease_ids = Array.from({length: 8}, (_, index) => `lease:active-${index + 1}`);
      subject.document.initial.active_work_count = 8;
      subject.document.initial.scheduler_state_digest = schedulerStateDigest(subject.document.initial.active_lease_ids);
      subject.document.action.expected_scheduler_state_digest = subject.document.initial.scheduler_state_digest;
    }],
    ['control.agent_not_ready', (subject) => { subject.document.initial.journal_available = false; }],
    ['control.agent_not_ready', (subject) => { subject.document.initial.semantic_dependency_available = false; }],
    ['control.agent_not_ready', (subject) => { subject.document.initial.control_channel.state = 'closed'; }],
  ];
  for (const [code, mutate] of mutations) {
    const subject = structuredClone(fixture.subject);
    mutate(subject);
    const observed = await observeControlPlaneScenario(subject, packageRoot);
    assert.deepEqual(observed.codes, [code]);
  }
});

test('enqueue requires the exact authenticated Work Journal head', async () => {
  const fixture = JSON.parse(await readFile(new URL('./scenarios/control-plane/durable-enqueue-survives-process-loss.json', import.meta.url)));
  fixture.subject.document.action.expected_journal_head_sequence += 1;
  assert.deepEqual((await observeControlPlaneScenario(fixture.subject, packageRoot)).codes,
    ['control.journal_head_stale']);

  const replayFixture = JSON.parse(await readFile(new URL('./scenarios/control-plane/duplicate-enqueue-idempotent.json', import.meta.url)));
  const replay = await observeControlPlaneScenario(replayFixture.subject, packageRoot);
  assert.equal(replay.verdict, 'pass');
  assert.deepEqual(replay.filesystem_effects, ['none']);
  assert.equal(replay.outputs.includes('enqueue idempotent'), true);
  assert.equal(replayFixture.subject.document.action.expected_journal_head_sequence,
    replayFixture.subject.document.initial.work.enqueue_receipt.base_head_sequence);
});

test('restart and recovery bind current journal and dependency state before opening the channel', async () => {
  const restartFixture = JSON.parse(await readFile(new URL('./scenarios/control-plane/queued-work-resumes-agent-restart.json', import.meta.url)));
  const staleRestart = structuredClone(restartFixture.subject);
  staleRestart.document.action.expected_dependency_state_digest = '0'.repeat(64);
  assert.deepEqual((await observeControlPlaneScenario(staleRestart, packageRoot)).codes,
    ['control.dependency_base_stale']);
  const authenticatedClosedRestart = structuredClone(restartFixture.subject);
  authenticatedClosedRestart.document.initial.control_channel.same_user_authenticated = true;
  assert.deepEqual((await observeControlPlaneScenario(authenticatedClosedRestart, packageRoot)).codes,
    ['control.control_channel_state_invalid']);

  const recoveryFixture = JSON.parse(await readFile(new URL('./scenarios/control-plane/in-flight-work-recovers-agent-crash.json', import.meta.url)));
  const mutations = [
    ['control.journal_head_stale', (subject) => { subject.document.action.expected_journal_head_digest = '0'.repeat(64); }],
    ['control.dependency_base_stale', (subject) => { subject.document.action.expected_dependency_state_digest = '0'.repeat(64); }],
    ['control.journal_unavailable', (subject) => { subject.document.initial.journal_available = false; }],
    ['control.semantic_dependency_unavailable', (subject) => { subject.document.initial.semantic_dependency_available = false; }],
    ['control.control_channel_state_invalid', (subject) => {
      subject.document.initial.control_channel.state = 'open';
      subject.document.initial.control_channel.same_user_authenticated = true;
    }],
  ];
  for (const [code, mutate] of mutations) {
    const subject = structuredClone(recoveryFixture.subject);
    mutate(subject);
    assert.deepEqual((await observeControlPlaneScenario(subject, packageRoot)).codes, [code]);
  }
});

test('readiness rejects a retained writer receipt from a stale epoch', async () => {
  const fixture = JSON.parse(await readFile(new URL('./scenarios/control-plane/readiness-work-journal-unavailable.json', import.meta.url)));
  const subject = structuredClone(fixture.subject);
  subject.document.initial.writer_epoch += 1;
  assert.deepEqual((await observeControlPlaneScenario(subject, packageRoot)).codes,
    ['control.writer_receipt_invalid']);

  const readyFixture = JSON.parse(await readFile(new URL('./scenarios/control-plane/dequeue-acknowledges-after-receipt.json', import.meta.url)));
  Object.assign(readyFixture.subject.document.action, {kind: 'readiness_check', actor_role: 'mdplace_agent'});
  readyFixture.subject.document.initial.agent_state = 'starting';
  readyFixture.subject.document.initial.control_channel.state = 'closed';
  readyFixture.subject.document.initial.control_channel.same_user_authenticated = false;
  const readyResult = await observeControlPlaneScenario(readyFixture.subject, packageRoot);
  assert.equal(readyResult.verdict, 'pass');
  assert.equal(readyResult.terminal_state, 'ready');

  readyFixture.subject.document.initial.control_channel.state = 'open';
  readyFixture.subject.document.initial.control_channel.same_user_authenticated = true;
  assert.deepEqual((await observeControlPlaneScenario(readyFixture.subject, packageRoot)).codes,
    ['control.control_channel_state_invalid']);
});

test('scenario terminal failure codes must match their durable exhaustion counters', async () => {
  const fixture = JSON.parse(await readFile(new URL('./scenarios/control-plane/completed-work-not-repeated-restart.json', import.meta.url)));
  const {work} = fixture.subject.document.initial;
  work.state = 'failed';
  Object.assign(work.completion_receipt, {
    outcome: 'failed', output_digest: null, code: 'control.recovery_ceiling_exceeded',
  });
  Object.assign(work.completion_receipt, signControlPlaneReceipt(
    'work_completion', completionFields(work.completion_receipt),
  ));
  work.completion_history = [structuredClone(work.completion_receipt)];

  assert.deepEqual((await observeControlPlaneScenario(fixture.subject, packageRoot)).codes,
    ['control.completion_receipt_invalid']);

  const obsoleteLease = JSON.parse(await readFile(new URL('./scenarios/control-plane/completed-work-not-repeated-restart.json', import.meta.url)));
  const initial = obsoleteLease.subject.document.initial;
  const completion = initial.work.completion_receipt;
  const laterLease = {
    ...structuredClone(initial.prior_lease_receipts[0]),
    receipt_id: 'lease-receipt:002', lease_id: 'lease:002', journal_sequence: 2,
  };
  Object.assign(laterLease, signControlPlaneReceipt('work_lease', [
    laterLease.receipt_id, laterLease.receipt_kind, laterLease.lease_id, laterLease.work_id,
    laterLease.work_version, laterLease.journal_sequence, laterLease.owner_agent_id,
  ]));
  initial.prior_lease_receipts.push(laterLease);
  completion.journal_sequence = 3;
  Object.assign(completion, signControlPlaneReceipt('work_completion', completionFields(completion)));
  initial.work.completion_history = [structuredClone(completion)];
  initial.journal_head_sequence = 3;
  initial.journal_head_receipt.head_sequence = 3;
  Object.assign(initial.journal_head_receipt, signControlPlaneReceipt(
    'work_journal_head', journalHeadFields(initial.journal_head_receipt),
  ));
  obsoleteLease.subject.document.action.expected_journal_head_sequence = 3;
  assert.deepEqual((await observeControlPlaneScenario(obsoleteLease.subject, packageRoot)).codes,
    ['control.completion_receipt_invalid']);
});

test('leased work requires authenticated durable lease evidence', async () => {
  const fixture = JSON.parse(await readFile(new URL('./scenarios/control-plane/first-retry-recorded.json', import.meta.url)));
  fixture.subject.document.initial.prior_lease_receipts[0].signature_digest = '0'.repeat(64);
  assert.deepEqual((await observeControlPlaneScenario(fixture.subject, packageRoot)).codes,
    ['control.lease_receipt_invalid']);
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
    expected_work_version: cancelled.document.initial.work.work_version,
    idempotency_key: cancelled.document.initial.work.idempotency_key});
  authenticateVaultOwnerAction(cancelled);
  const cancellationResult = await observeControlPlaneScenario(cancelled, packageRoot);
  assert.equal(cancellationResult.verdict, 'pass');
  assert.deepEqual(cancellationResult.filesystem_effects, ['none']);
  assert.equal(cancellationResult.outputs.includes('cancellation idempotent'), true);

  const closedCancellation = structuredClone(cancelled);
  Object.assign(closedCancellation.document.initial.control_channel,
    {state: 'closed', same_user_authenticated: false});
  assert.deepEqual((await observeControlPlaneScenario(closedCancellation, packageRoot)).codes,
    ['control.vault_owner_authentication_denied']);

  const forgedOwner = structuredClone(cancelled);
  forgedOwner.document.action.vault_owner_receipt.signature_digest = '0'.repeat(64);
  assert.deepEqual((await observeControlPlaneScenario(forgedOwner, packageRoot)).codes,
    ['control.vault_owner_authentication_denied']);

  const staleCancellation = structuredClone(cancelledFixture.subject);
  Object.assign(staleCancellation.document.action, {kind: 'cancel', actor_role: 'vault_owner',
    work_id: staleCancellation.document.initial.work.work_id,
    expected_work_version: staleCancellation.document.initial.work.work_version,
    idempotency_key: 'idempotency:other-001'});
  authenticateVaultOwnerAction(staleCancellation);
  assert.deepEqual((await observeControlPlaneScenario(staleCancellation, packageRoot)).codes,
    ['control.cancellation_receipt_invalid']);

  const forgedCancellation = structuredClone(cancelled);
  forgedCancellation.document.initial.work.cancellation_receipt.signature_digest = '0'.repeat(64);
  forgedCancellation.document.initial.work.cancellation_history.at(-1).signature_digest = '0'.repeat(64);
  assert.deepEqual((await observeControlPlaneScenario(forgedCancellation, packageRoot)).codes,
    ['control.cancellation_receipt_invalid']);

  const forgedRestart = structuredClone(cancelledFixture.subject);
  forgedRestart.document.initial.work.cancellation_receipt.signature_digest = '0'.repeat(64);
  forgedRestart.document.initial.work.cancellation_history.at(-1).signature_digest = '0'.repeat(64);
  assert.deepEqual((await observeControlPlaneScenario(forgedRestart, packageRoot)).codes,
    ['control.cancellation_receipt_invalid']);

  const resumeFixture = JSON.parse(await readFile(new URL('./scenarios/control-plane/authorized-bounded-resume-recorded.json', import.meta.url)));
  resumeFixture.subject.document.action.idempotency_key = 'idempotency:other-001';
  authenticateVaultOwnerAction(resumeFixture.subject);
  assert.deepEqual((await observeControlPlaneScenario(resumeFixture.subject, packageRoot)).codes,
    ['control.idempotency_incompatible']);

  const closedResume = JSON.parse(await readFile(new URL('./scenarios/control-plane/authorized-bounded-resume-recorded.json', import.meta.url)));
  Object.assign(closedResume.subject.document.initial.control_channel,
    {state: 'closed', same_user_authenticated: false});
  assert.deepEqual((await observeControlPlaneScenario(closedResume.subject, packageRoot)).codes,
    ['control.vault_owner_authentication_denied']);

  const staleLease = JSON.parse(await readFile(new URL('./scenarios/control-plane/cancellation-during-execution-durable.json', import.meta.url)));
  staleLease.subject.document.action.lease_id = 'lease:stale-999';
  authenticateVaultOwnerAction(staleLease.subject);
  assert.deepEqual((await observeControlPlaneScenario(staleLease.subject, packageRoot)).codes,
    ['control.lease_stale']);

  const replayFixture = JSON.parse(await readFile(new URL('./scenarios/control-plane/authorized-bounded-resume-recorded.json', import.meta.url)));
  const replayInitial = replayFixture.subject.document.initial;
  const cancelledVersion = replayInitial.work.work_version;
  Object.assign(replayInitial.work, {
    work_version: cancelledVersion + 1, state: 'queued', cancellation_id: null,
    resume_count: 1, completion_receipt: null,
  });
  replayInitial.work.resume_receipt = {
    receipt_id: 'resume-receipt:work-001', work_id: replayInitial.work.work_id,
    cancelled_work_version: cancelledVersion, resumed_work_version: cancelledVersion + 1,
    idempotency_key: replayInitial.work.idempotency_key,
    cancellation_receipt_id: replayInitial.work.cancellation_receipt.receipt_id,
    resume_count: 1, journal_sequence: replayInitial.journal_head_sequence + 1,
  };
  Object.assign(replayInitial.work.resume_receipt, signControlPlaneReceipt(
    'work_resume', resumeFields(replayInitial.work.resume_receipt),
  ));
  replayInitial.journal_head_sequence += 1;
  replayInitial.journal_head_receipt.head_sequence = replayInitial.journal_head_sequence;
  Object.assign(replayInitial.journal_head_receipt, signControlPlaneReceipt(
    'work_journal_head', journalHeadFields(replayInitial.journal_head_receipt),
  ));
  replayFixture.subject.document.action.expected_work_version = cancelledVersion;
  const replayResult = await observeControlPlaneScenario(replayFixture.subject, packageRoot);
  assert.equal(replayResult.verdict, 'pass');
  assert.deepEqual(replayResult.filesystem_effects, ['none']);
  assert.equal(replayResult.outputs.includes('resume idempotent'), true);

  const nonQueuedReplay = structuredClone(replayFixture.subject);
  Object.assign(nonQueuedReplay.document.initial.work,
    {state: 'retry_wait', retry_eligible_tick: 1000});
  assert.deepEqual((await observeControlPlaneScenario(nonQueuedReplay, packageRoot)).codes,
    ['control.work_version_stale']);

  const recancellation = structuredClone(replayFixture.subject);
  Object.assign(recancellation.document.action, {
    kind: 'cancel', actor_role: 'vault_owner',
    expected_work_version: recancellation.document.initial.work.work_version,
    lease_id: null,
  });
  authenticateVaultOwnerAction(recancellation);
  const recancellationResult = await observeControlPlaneScenario(recancellation, packageRoot);
  assert.equal(recancellationResult.verdict, 'pass');
  assert.deepEqual(recancellationResult.receipts.map((receipt) => receipt.split(':')[0]),
    ['CancellationReceipt', 'CompletionReceipt']);
  assert.deepEqual(recancellationResult.filesystem_effects,
    ['append durable cancellation record', 'append durable terminal completion record']);

  replayInitial.work.resume_receipt.signature_digest = '0'.repeat(64);
  assert.deepEqual((await observeControlPlaneScenario(replayFixture.subject, packageRoot)).codes,
    ['control.resume_receipt_invalid']);

  const readinessFixture = JSON.parse(await readFile(new URL('./scenarios/control-plane/readiness-work-journal-unavailable.json', import.meta.url)));
  readinessFixture.subject.document.initial.agent_state = 'ready';
  const readinessResult = await observeControlPlaneScenario(readinessFixture.subject, packageRoot);
  assert.deepEqual(readinessResult.codes, ['control.illegal_transition']);
  assert.equal(readinessResult.illegal_transition, true);
});

test('cancellation reserves distinct durable cancellation and completion sequences', async () => {
  const fixture = JSON.parse(await readFile(new URL('./scenarios/control-plane/cancellation-before-dispatch-durable.json', import.meta.url)));
  const boundary = structuredClone(fixture.subject);
  const {initial} = boundary.document;
  initial.journal_head_sequence = 999998;
  initial.journal_head_receipt.head_sequence = initial.journal_head_sequence;
  Object.assign(initial.journal_head_receipt, signControlPlaneReceipt(
    'work_journal_head', journalHeadFields(initial.journal_head_receipt),
  ));
  const accepted = await observeControlPlaneScenario(boundary, packageRoot);
  assert.equal(accepted.verdict, 'pass');
  assert.deepEqual(accepted.receipts.map((receipt) => receipt.split(':')[0]),
    ['CancellationReceipt', 'CompletionReceipt']);
  assert.deepEqual(accepted.filesystem_effects,
    ['append durable cancellation record', 'append durable terminal completion record']);

  initial.journal_head_sequence = 999999;
  initial.journal_head_receipt.head_sequence = initial.journal_head_sequence;
  Object.assign(initial.journal_head_receipt, signControlPlaneReceipt(
    'work_journal_head', journalHeadFields(initial.journal_head_receipt),
  ));
  assert.deepEqual((await observeControlPlaneScenario(boundary, packageRoot)).codes,
    ['control.journal_capacity_exhausted']);
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
    outcome: 'failed', receipt_id: 'receipt:failed-001', work_id: work.work_id, work_version: work.work_version,
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
    journal.head_sequence = 3;
    work.state = 'failed';
    work.result = {outcome: 'failed', receipt_id: 'receipt:failed-001', work_version: work.work_version,
      work_id: work.work_id, lease_id: 'lease:001', journal_sequence: 3, output_digest: null, code: 'control.execution_failed'};
    Object.assign(work.result, signControlPlaneReceipt('work_completion', [
      work.result.receipt_id, work.work_id, work.result.work_version, work.result.lease_id,
      work.result.journal_sequence, work.result.outcome, '', work.result.code,
    ]));
    work.completion_history = [work.result];
    journal.receipts.push({receipt_id: 'receipt:lease-001', receipt_kind: 'lease',
      journal_sequence: 2, work_id: work.work_id, work_version: work.work_version,
      lease_id: work.result.lease_id, state: 'leased', operation_digest: 'b'.repeat(64),
      semantic_state_digest: 'd'.repeat(64)});
    journal.receipts.push({receipt_id: work.result.receipt_id, receipt_kind: 'completion',
      journal_sequence: 3, work_id: work.work_id, work_version: work.work_version,
      lease_id: work.result.lease_id,
      state: 'failed', operation_digest: 'a'.repeat(64), semantic_state_digest: 'd'.repeat(64)});
    journal.head_digest = workJournalHeadDigest(journal.receipts);
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
    nullSuccess.work.result.receipt_id, nullSuccess.work.work_id, nullSuccess.work.result.work_version,
    nullSuccess.work.result.lease_id,
    nullSuccess.work.result.journal_sequence, 'succeeded', '', '',
  ]));
  nullSuccess.journal.receipts.at(-1).state = 'succeeded';
  nullSuccess.journal.head_digest = workJournalHeadDigest(nullSuccess.journal.receipts);
  await writeFile(nullSuccess.journalPath, `${JSON.stringify(nullSuccess.journal, null, 2)}\n`);
  const nullReport = await buildValidationReport(nullSuccess.temporaryRoot);
  assert.ok(nullReport.checks.find(({id}) => id === 'control-plane-contract').codes
    .includes('control.work_journal_state_invalid'));

  const collision = await terminalJournal();
  collision.work.result.journal_sequence = 1;
  collision.journal.receipts.at(-1).journal_sequence = 1;
  Object.assign(collision.work.result, signControlPlaneReceipt('work_completion', [
    collision.work.result.receipt_id, collision.work.work_id, collision.work.result.work_version,
    collision.work.result.lease_id,
    1, collision.work.result.outcome, '', collision.work.result.code,
  ]));
  collision.journal.head_digest = workJournalHeadDigest(collision.journal.receipts);
  await writeFile(collision.journalPath, `${JSON.stringify(collision.journal, null, 2)}\n`);
  const collisionReport = await buildValidationReport(collision.temporaryRoot);
  assert.ok(collisionReport.checks.find(({id}) => id === 'control-plane-contract').codes
    .includes('control.work_journal_state_invalid'));

  const wrongLease = await terminalJournal();
  wrongLease.work.result.lease_id = 'lease:other-001';
  wrongLease.journal.receipts.at(-1).lease_id = wrongLease.work.result.lease_id;
  Object.assign(wrongLease.work.result, signControlPlaneReceipt('work_completion', [
    wrongLease.work.result.receipt_id, wrongLease.work.work_id, wrongLease.work.result.work_version,
    wrongLease.work.result.lease_id, wrongLease.work.result.journal_sequence,
    wrongLease.work.result.outcome, '', wrongLease.work.result.code,
  ]));
  wrongLease.journal.head_digest = workJournalHeadDigest(wrongLease.journal.receipts);
  await writeFile(wrongLease.journalPath, `${JSON.stringify(wrongLease.journal, null, 2)}\n`);
  const wrongLeaseReport = await buildValidationReport(wrongLease.temporaryRoot);
  assert.ok(wrongLeaseReport.checks.find(({id}) => id === 'control-plane-contract').codes
    .includes('control.work_journal_state_invalid'));

  const obsoleteLease = await terminalJournal();
  obsoleteLease.journal.head_sequence = 5;
  obsoleteLease.work.result.journal_sequence = 5;
  Object.assign(obsoleteLease.work.result, signControlPlaneReceipt('work_completion', [
    obsoleteLease.work.result.receipt_id, obsoleteLease.work.work_id,
    obsoleteLease.work.result.work_version, obsoleteLease.work.result.lease_id,
    obsoleteLease.work.result.journal_sequence, obsoleteLease.work.result.outcome, '',
    obsoleteLease.work.result.code,
  ]));
  Object.assign(obsoleteLease.journal.receipts.at(-1), {journal_sequence: 5});
  obsoleteLease.journal.receipts.splice(2, 0,
    {receipt_id: 'receipt:retry-001', receipt_kind: 'retry', journal_sequence: 3,
      work_id: obsoleteLease.work.work_id, work_version: obsoleteLease.work.work_version,
      lease_id: null, state: 'retry_wait', operation_digest: 'c'.repeat(64),
      semantic_state_digest: 'd'.repeat(64)},
    {receipt_id: 'receipt:lease-002', receipt_kind: 'lease', journal_sequence: 4,
      work_id: obsoleteLease.work.work_id, work_version: obsoleteLease.work.work_version,
      lease_id: 'lease:002', state: 'leased', operation_digest: 'e'.repeat(64),
      semantic_state_digest: 'd'.repeat(64)},
  );
  obsoleteLease.journal.head_digest = workJournalHeadDigest(obsoleteLease.journal.receipts);
  await writeFile(obsoleteLease.journalPath, `${JSON.stringify(obsoleteLease.journal, null, 2)}\n`);
  const obsoleteLeaseReport = await buildValidationReport(obsoleteLease.temporaryRoot);
  assert.ok(obsoleteLeaseReport.checks.find(({id}) => id === 'control-plane-contract').codes
    .includes('control.work_journal_state_invalid'));

  const wrongFailure = await terminalJournal();
  wrongFailure.work.result.code = 'control.recovery_ceiling_exceeded';
  Object.assign(wrongFailure.work.result, signControlPlaneReceipt('work_completion', [
    wrongFailure.work.result.receipt_id, wrongFailure.work.work_id, wrongFailure.work.result.work_version,
    wrongFailure.work.result.lease_id, wrongFailure.work.result.journal_sequence,
    wrongFailure.work.result.outcome, '', wrongFailure.work.result.code,
  ]));
  await writeFile(wrongFailure.journalPath, `${JSON.stringify(wrongFailure.journal, null, 2)}\n`);
  const wrongFailureReport = await buildValidationReport(wrongFailure.temporaryRoot);
  assert.ok(wrongFailureReport.checks.find(({id}) => id === 'control-plane-contract').codes
    .includes('control.work_journal_state_invalid'));

  const cancelled = await terminalJournal();
  cancelled.journal.head_sequence = 4;
  Object.assign(cancelled.work, {state: 'cancelled', work_version: 2});
  const cancellationAuthorization = {
    receipt_id: 'vault-owner-receipt:cancel-001-v1', principal_id: 'person:owner-001',
    vault_id: cancelled.journal.vault_id, action_kind: 'cancel', work_id: cancelled.work.work_id,
    work_version: 1, lease_id: 'lease:001', idempotency_key: cancelled.work.idempotency_key,
  };
  Object.assign(cancellationAuthorization, signControlPlaneReceipt(
    'vault_owner_authorization', vaultOwnerFields(cancellationAuthorization),
  ));
  cancelled.work.cancellation = {
    receipt_id: 'cancellation-receipt:001', cancellation_id: 'cancel:001',
    work_id: cancelled.work.work_id, work_version: cancelled.work.work_version,
    idempotency_key: cancelled.work.idempotency_key, requested_by: 'person:owner-001',
    vault_owner_receipt: cancellationAuthorization,
    journal_sequence: 3, reason_code: 'user_requested', resume_count: 0, resume_ceiling: 1,
  };
  Object.assign(cancelled.work.cancellation, signControlPlaneReceipt(
    'work_journal_cancellation', journalCancellationFields(cancelled.work.cancellation),
  ));
  Object.assign(cancelled.work.result, {outcome: 'cancelled', receipt_id: 'receipt:cancelled-001',
    work_version: 2, journal_sequence: 4, output_digest: null, code: 'control.cancelled'});
  Object.assign(cancelled.work.result, signControlPlaneReceipt('work_completion', [
    cancelled.work.result.receipt_id, cancelled.work.work_id, cancelled.work.result.work_version,
    cancelled.work.result.lease_id, cancelled.work.result.journal_sequence,
    cancelled.work.result.outcome, '', cancelled.work.result.code,
  ]));
  const completionRow = cancelled.journal.receipts.at(-1);
  Object.assign(completionRow, {receipt_id: cancelled.work.result.receipt_id,
    journal_sequence: 4, work_version: 2, state: 'cancelled'});
  cancelled.journal.receipts.splice(-1, 0, {
    receipt_id: cancelled.work.cancellation.receipt_id, receipt_kind: 'cancellation',
    journal_sequence: 3, work_id: cancelled.work.work_id,
    work_version: cancelled.work.work_version, lease_id: cancelled.work.result.lease_id,
    state: 'cancelled', operation_digest: 'c'.repeat(64), semantic_state_digest: 'd'.repeat(64),
  });
  cancelled.work.cancellation_history = [cancelled.work.cancellation];
  cancelled.work.completion_history = [cancelled.work.result];
  cancelled.journal.head_digest = workJournalHeadDigest(cancelled.journal.receipts);
  await writeFile(cancelled.journalPath, `${JSON.stringify(cancelled.journal, null, 2)}\n`);
  const cancelledReport = await buildValidationReport(cancelled.temporaryRoot);
  assert.equal(cancelledReport.checks.find(({id}) => id === 'control-plane-contract').codes
    .includes('control.work_journal_state_invalid'), false);

  cancelled.work.cancellation.journal_sequence = 4;
  Object.assign(cancelled.work.cancellation, signControlPlaneReceipt(
    'work_journal_cancellation', journalCancellationFields(cancelled.work.cancellation),
  ));
  cancelled.work.result.journal_sequence = 3;
  Object.assign(cancelled.work.result, signControlPlaneReceipt('work_completion', [
    cancelled.work.result.receipt_id, cancelled.work.work_id, cancelled.work.result.work_version,
    cancelled.work.result.lease_id, cancelled.work.result.journal_sequence,
    cancelled.work.result.outcome, '', cancelled.work.result.code,
  ]));
  Object.assign(cancelled.journal.receipts.at(-2), {journal_sequence: 4});
  Object.assign(cancelled.journal.receipts.at(-1), {journal_sequence: 3});
  cancelled.journal.head_digest = workJournalHeadDigest(cancelled.journal.receipts);
  await writeFile(cancelled.journalPath, `${JSON.stringify(cancelled.journal, null, 2)}\n`);
  const reversedCancellationReport = await buildValidationReport(cancelled.temporaryRoot);
  assert.ok(reversedCancellationReport.checks.find(({id}) => id === 'control-plane-contract').codes
    .includes('control.work_journal_state_invalid'));

  cancelled.work.cancellation = null;
  await writeFile(cancelled.journalPath, `${JSON.stringify(cancelled.journal, null, 2)}\n`);
  const missingCancellationReport = await buildValidationReport(cancelled.temporaryRoot);
  assert.ok(missingCancellationReport.checks.find(({id}) => id === 'control-plane-contract').codes
    .includes('control.work_journal_state_invalid'));
});

test('Work Journal authenticates and correlates bounded resume history', async () => {
  const temporaryRoot = await copyCommittedPackage();
  const journalPath = `${temporaryRoot}/contracts/control-plane/work-journal.json`;
  const journal = JSON.parse(await readFile(journalPath));
  const work = journal.work_items[0];
  Object.assign(work, {work_version: 3, state: 'queued', resume_count: 1});
  const authorization = {
    receipt_id: 'vault-owner-receipt:cancel-001-v1', principal_id: 'person:owner-001',
    vault_id: journal.vault_id, action_kind: 'cancel', work_id: work.work_id,
    work_version: 1, lease_id: null, idempotency_key: work.idempotency_key,
  };
  Object.assign(authorization, signControlPlaneReceipt(
    'vault_owner_authorization', vaultOwnerFields(authorization),
  ));
  work.cancellation = {
    receipt_id: 'cancellation-receipt:001', cancellation_id: 'cancel:001',
    work_id: work.work_id, work_version: 2, idempotency_key: work.idempotency_key,
    requested_by: 'person:owner-001', vault_owner_receipt: authorization,
    journal_sequence: 2, reason_code: 'user_requested',
    resume_count: 0, resume_ceiling: 1,
  };
  Object.assign(work.cancellation, signControlPlaneReceipt(
    'work_journal_cancellation', journalCancellationFields(work.cancellation),
  ));
  work.cancellation_history = [work.cancellation];
  const cancellationCompletion = {
    receipt_id: 'receipt:cancelled-001', work_id: work.work_id, work_version: 2,
    lease_id: null, journal_sequence: 3, outcome: 'cancelled', output_digest: null,
    code: 'control.cancelled',
  };
  Object.assign(cancellationCompletion, signControlPlaneReceipt('work_completion', [
    cancellationCompletion.receipt_id, work.work_id, cancellationCompletion.work_version, '',
    cancellationCompletion.journal_sequence, cancellationCompletion.outcome, '',
    cancellationCompletion.code,
  ]));
  work.completion_history = [cancellationCompletion];
  work.resume_receipt = {
    receipt_id: 'resume-receipt:001', work_id: work.work_id,
    cancelled_work_version: 2, resumed_work_version: 3,
    idempotency_key: work.idempotency_key,
    cancellation_receipt_id: work.cancellation.receipt_id,
    resume_count: 1, journal_sequence: 4,
  };
  Object.assign(work.resume_receipt, signControlPlaneReceipt(
    'work_resume', resumeFields(work.resume_receipt),
  ));
  journal.receipts.push({
    receipt_id: work.cancellation.receipt_id, receipt_kind: 'cancellation',
    journal_sequence: 2, work_id: work.work_id, work_version: 2, lease_id: null,
    state: 'cancelled', operation_digest: 'c'.repeat(64), semantic_state_digest: 'd'.repeat(64),
  }, {
    receipt_id: cancellationCompletion.receipt_id, receipt_kind: 'completion',
    journal_sequence: 3, work_id: work.work_id, work_version: 2, lease_id: null,
    state: 'cancelled', operation_digest: 'f'.repeat(64), semantic_state_digest: 'd'.repeat(64),
  }, {
    receipt_id: work.resume_receipt.receipt_id, receipt_kind: 'resume',
    journal_sequence: 4, work_id: work.work_id, work_version: 3, lease_id: null,
    state: 'queued', operation_digest: 'e'.repeat(64), semantic_state_digest: 'd'.repeat(64),
  });
  journal.head_sequence = 4;
  journal.head_digest = workJournalHeadDigest(journal.receipts);
  await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  const validReport = await buildValidationReport(temporaryRoot);
  assert.equal(validReport.checks.find(({id}) => id === 'control-plane-contract').codes
    .includes('control.work_journal_state_invalid'), false);

  const validJournal = structuredClone(journal);
  work.cancellation.resume_count = 1;
  Object.assign(work.cancellation, signControlPlaneReceipt(
    'work_journal_cancellation', journalCancellationFields(work.cancellation),
  ));
  work.cancellation_history = [work.cancellation];
  await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  const exhaustedHistoryReport = await buildValidationReport(temporaryRoot);
  assert.ok(exhaustedHistoryReport.checks.find(({id}) => id === 'control-plane-contract').codes
    .includes('control.work_journal_state_invalid'));

  const missingCompletionRoot = await copyCommittedPackage();
  const missingCompletionPath = `${missingCompletionRoot}/contracts/control-plane/work-journal.json`;
  const missingCompletion = structuredClone(validJournal);
  const missingWork = missingCompletion.work_items[0];
  missingWork.completion_history = [];
  missingWork.resume_receipt.journal_sequence = 3;
  Object.assign(missingWork.resume_receipt, signControlPlaneReceipt(
    'work_resume', resumeFields(missingWork.resume_receipt),
  ));
  missingCompletion.receipts = missingCompletion.receipts.filter(({receipt_kind: kind}) => kind !== 'completion');
  missingCompletion.receipts.find(({receipt_kind: kind}) => kind === 'resume').journal_sequence = 3;
  missingCompletion.head_sequence = 3;
  missingCompletion.head_digest = workJournalHeadDigest(missingCompletion.receipts);
  await writeFile(missingCompletionPath, `${JSON.stringify(missingCompletion, null, 2)}\n`);
  const missingCompletionReport = await buildValidationReport(missingCompletionRoot);
  assert.ok(missingCompletionReport.checks.find(({id}) => id === 'control-plane-contract').codes
    .includes('control.work_journal_state_invalid'));

  Object.assign(journal, validJournal);
  journal.work_items[0].resume_receipt.signature_digest = '0'.repeat(64);
  await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  const forgedReport = await buildValidationReport(temporaryRoot);
  assert.ok(forgedReport.checks.find(({id}) => id === 'control-plane-contract').codes
    .includes('control.work_journal_state_invalid'));
});

test('Work Journal head sequence and digest bind one contiguous receipt chain', async () => {
  const temporaryRoot = await copyCommittedPackage();
  const journalPath = `${temporaryRoot}/contracts/control-plane/work-journal.json`;
  const journal = JSON.parse(await readFile(journalPath));
  journal.receipts[0].journal_sequence = 2;
  journal.head_sequence = 2;
  journal.head_digest = workJournalHeadDigest(journal.receipts);
  await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  const report = await buildValidationReport(temporaryRoot);
  assert.ok(report.checks.find(({id}) => id === 'control-plane-contract').codes
    .includes('control.work_journal_state_invalid'));

  const enqueueRoot = await copyCommittedPackage();
  const enqueuePath = `${enqueueRoot}/contracts/control-plane/work-journal.json`;
  const enqueueJournal = JSON.parse(await readFile(enqueuePath));
  const enqueueReceipt = enqueueJournal.work_items[0].enqueue_receipt;
  enqueueReceipt.base_head_digest = '0'.repeat(64);
  Object.assign(enqueueReceipt, signControlPlaneReceipt(
    'work_enqueue', [enqueueReceipt.receipt_id, enqueueReceipt.work_id,
      enqueueReceipt.work_version, enqueueReceipt.idempotency_key, enqueueReceipt.input_digest,
      enqueueReceipt.base_head_sequence, enqueueReceipt.base_head_digest,
      enqueueReceipt.journal_sequence],
  ));
  await writeFile(enqueuePath, `${JSON.stringify(enqueueJournal, null, 2)}\n`);
  const enqueueReport = await buildValidationReport(enqueueRoot);
  assert.ok(enqueueReport.checks.find(({id}) => id === 'control-plane-contract').codes
    .includes('control.work_journal_state_invalid'));
});

test('Work Journal rejects every orphan lifecycle record kind', async () => {
  const orphanRows = [
    ['enqueue-receipt:orphan-001', 'enqueue', 'queued'],
    ['cancellation-receipt:orphan-001', 'cancellation', 'cancelled'],
    ['resume-receipt:orphan-001', 'resume', 'queued'],
    ['receipt:orphan-completion-001', 'completion', 'failed'],
  ];
  for (const [receiptId, receiptKind, state] of orphanRows) {
    const temporaryRoot = await copyCommittedPackage();
    const journalPath = `${temporaryRoot}/contracts/control-plane/work-journal.json`;
    const journal = JSON.parse(await readFile(journalPath));
    const work = journal.work_items[0];
    journal.receipts.push({
      receipt_id: receiptId, receipt_kind: receiptKind, journal_sequence: 2,
      work_id: work.work_id, work_version: work.work_version, lease_id: null, state,
      operation_digest: 'a'.repeat(64), semantic_state_digest: 'd'.repeat(64),
    });
    journal.head_sequence = 2;
    journal.head_digest = workJournalHeadDigest(journal.receipts);
    await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
    const report = await buildValidationReport(temporaryRoot);
    assert.ok(report.checks.find(({id}) => id === 'control-plane-contract').codes
      .includes('control.work_journal_state_invalid'));
  }
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

  const horizon = JSON.parse(await readFile(new URL('./scenarios/control-plane/first-retry-recorded.json', import.meta.url)));
  Object.assign(horizon.subject.document.initial.work, {
    lease_acquired_tick: 998600, lease_expires_tick: 998900,
  });
  horizon.subject.document.action.current_tick = 998701;
  const horizonResult = await observeControlPlaneScenario(horizon.subject, packageRoot);
  assert.equal(horizonResult.verdict, 'pass');
  assert.equal(horizonResult.terminal_state, 'failed');
  assert.equal(horizonResult.outputs.includes('retry eligibility tick overflow produced terminal failure'), true);
});

test('dispatch and journal append reject arithmetic beyond their closed domains', async () => {
  const dispatchFixture = JSON.parse(await readFile(new URL('./scenarios/control-plane/dequeue-acknowledges-after-receipt.json', import.meta.url)));
  dispatchFixture.subject.document.action.current_tick = 1000000;
  assert.deepEqual((await observeControlPlaneScenario(dispatchFixture.subject, packageRoot)).codes,
    ['control.lease_tick_overflow']);

  const failureFixture = JSON.parse(await readFile(new URL('./scenarios/control-plane/retry-ceiling-terminal-failure.json', import.meta.url)));
  failureFixture.subject.document.initial.journal_head_sequence = 1000000;
  failureFixture.subject.document.initial.journal_head_digest = 'f'.repeat(64);
  Object.assign(failureFixture.subject.document.initial.journal_head_receipt, {
    head_sequence: 1000000, head_digest: 'f'.repeat(64),
  });
  Object.assign(failureFixture.subject.document.initial.journal_head_receipt, signControlPlaneReceipt(
    'work_journal_head', journalHeadFields(failureFixture.subject.document.initial.journal_head_receipt),
  ));
  assert.deepEqual((await observeControlPlaneScenario(failureFixture.subject, packageRoot)).codes,
    ['control.journal_capacity_exhausted']);
});
