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
import {
  scenarioLifecycleDigest,
  scenarioLifecycleDigestAtSequence,
} from './control-plane-scenario-history.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const validator = fileURLToPath(new URL('./validator.mjs', import.meta.url));

function workJournalHeadDigest(receipts) {
  return createHash('sha256').update(canonicalJson([...receipts]
    .sort((left, right) => left.journal_sequence - right.journal_sequence))).digest('hex');
}

const journalRecordDetailFields = [
  'owner_agent_id', 'acquired_tick', 'expires_tick', 'lease_status', 'started_tick',
  'retry_count', 'failure_retryable', 'failure_observed_tick', 'selected_retry_delay_ticks',
  'retry_eligible_tick', 'recovery_interruption_count', 'resulting_retry_count',
  'recovery_tick', 'recovery_lease_status', 'recovery_decision', 'rejection_code',
];

function journalRecordFields(receipt) {
  return [receipt.receipt_id, receipt.receipt_kind, receipt.journal_sequence,
    receipt.work_id, receipt.work_version, receipt.lease_id ?? '', receipt.state,
    receipt.operation_digest, receipt.semantic_state_digest,
    ...journalRecordDetailFields.map((field) => receipt[field] ?? '')];
}

function authenticateJournalRecord(receipt) {
  Object.assign(receipt, signControlPlaneReceipt('work_journal_record', journalRecordFields(receipt)));
  return receipt;
}

function schedulerStateDigest(activeLeaseIds, maxConcurrentWork = 8) {
  return createHash('sha256').update(canonicalJson({
    active_lease_ids: [...activeLeaseIds].sort(),
    max_concurrent_work: maxConcurrentWork,
  })).digest('hex');
}

function schedulerLeaseFields(receipt) {
  return [receipt.receipt_id, receipt.vault_id, receipt.lease_id, receipt.work_id,
    receipt.work_version, receipt.owner_agent_id, receipt.acquired_tick,
    receipt.expires_tick, receipt.status];
}

function authenticateScenarioScheduler(initial, observationTick) {
  initial.scheduler_observed_tick = observationTick;
  const prefixLeases = initial.journal_prefix_receipt.active_leases.filter((lease) =>
    lease.work_id !== initial.work?.work_id && lease.acquired_tick <= observationTick &&
    observationTick < lease.expires_tick);
  const work = initial.work;
  const endEvents = work === null ? [] : [
    ...(initial.prior_retry_receipts ?? []).map((receipt) => ({lease_id: receipt.lease_id, tick: receipt.failure_tick})),
    ...(initial.prior_recovery_receipts ?? []).map((receipt) => ({lease_id: receipt.lease_id, tick: receipt.recovery_tick})),
    ...work.cancellation_history.map((receipt) => ({
      lease_id: receipt.vault_owner_receipt.lease_id, tick: receipt.cancellation_tick,
    })),
    ...work.completion_history.map((receipt) => ({lease_id: receipt.lease_id, tick: receipt.completion_tick})),
  ];
  const currentLease = work === null ? [] : initial.prior_lease_receipts
    .filter(({receipt_kind: kind}) => kind === 'lease')
    .flatMap((lease) => {
      const endTick = endEvents.filter(({lease_id: id}) => id === lease.lease_id)
        .reduce((earliest, {tick}) => Math.min(earliest, tick), lease.expires_tick);
      if (lease.acquired_tick > observationTick || observationTick >= endTick) return [];
      const start = initial.prior_lease_receipts.filter((receipt) =>
        receipt.receipt_kind === 'start' && receipt.lease_id === lease.lease_id &&
        receipt.started_tick <= observationTick).at(-1);
      return [{
        lease_id: lease.lease_id, work_id: lease.work_id,
        work_version: start?.work_version ?? lease.work_version,
        owner_agent_id: lease.owner_agent_id, acquired_tick: lease.acquired_tick,
        expires_tick: lease.expires_tick, status: 'active',
      }];
    });
  initial.scheduler_active_lease_receipts = [...prefixLeases, ...currentLease].map((lease) => {
    const receipt = {
      receipt_id: `scheduler-lease-receipt:${lease.lease_id.slice(6)}`,
      vault_id: initial.vault_id,
      ...lease,
    };
    return {...receipt, ...signControlPlaneReceipt(
      'scheduler_active_lease', schedulerLeaseFields(receipt),
    )};
  });
  initial.active_lease_ids = initial.scheduler_active_lease_receipts.map(({lease_id: id}) => id);
  initial.active_work_count = initial.active_lease_ids.length;
  initial.scheduler_state_digest = schedulerStateDigest(initial.active_lease_ids);
}

function journalPrefixFields(receipt) {
  return [receipt.receipt_id, receipt.journal_id, receipt.head_sequence, receipt.head_digest,
    canonicalJson(receipt.active_leases)];
}

function journalCancellationFields(cancellation) {
  return [cancellation.receipt_id, cancellation.cancellation_id, cancellation.work_id,
    cancellation.work_version, cancellation.idempotency_key, cancellation.requested_by,
    cancellation.vault_owner_receipt.receipt_id, cancellation.vault_owner_receipt.signature_digest,
    cancellation.journal_sequence, cancellation.cancellation_tick, cancellation.reason_code, cancellation.resume_count,
    cancellation.resume_ceiling];
}

function journalHeadFields(receipt) {
  return [receipt.receipt_id, receipt.journal_id, receipt.head_sequence, receipt.head_digest];
}

function authenticateScenarioHead(initial) {
  const work = initial.work;
  const suffixLength = work === null ? 0 : [
    work.enqueue_receipt,
    ...initial.prior_lease_receipts,
    ...(initial.prior_retry_receipts ?? []),
    ...(initial.prior_recovery_receipts ?? []),
    ...work.cancellation_history,
    ...work.completion_history,
    ...(work.resume_receipt === null ? [] : [work.resume_receipt]),
  ].length;
  initial.journal_head_sequence = initial.journal_prefix_receipt.head_sequence + suffixLength;
  initial.journal_head_digest = scenarioLifecycleDigest(initial);
  initial.journal_head_receipt.head_sequence = initial.journal_head_sequence;
  initial.journal_head_receipt.head_digest = initial.journal_head_digest;
  Object.assign(initial.journal_head_receipt, signControlPlaneReceipt(
    'work_journal_head', journalHeadFields(initial.journal_head_receipt),
  ));
}

function leaseFields(receipt) {
  return [receipt.receipt_id, receipt.receipt_kind, receipt.lease_id, receipt.work_id,
    receipt.work_version, receipt.journal_sequence, receipt.owner_agent_id,
    receipt.acquired_tick, receipt.expires_tick, receipt.started_tick ?? '', receipt.status];
}

function recoveryFields(receipt) {
  return [receipt.receipt_id, receipt.receipt_kind, receipt.lease_id, receipt.work_id,
    receipt.work_version, receipt.journal_sequence, receipt.prior_state,
    receipt.prior_retry_count, receipt.recovery_interruption_count,
    receipt.resulting_retry_count, receipt.recovery_tick, receipt.recovery_lease_status,
    receipt.recovery_decision, receipt.selected_retry_delay_ticks ?? '', receipt.resulting_state];
}

function retryFields(receipt) {
  return [receipt.receipt_id, receipt.receipt_kind, receipt.lease_id, receipt.work_id,
    receipt.work_version, receipt.journal_sequence, receipt.prior_retry_count,
    receipt.resulting_retry_count, receipt.failure_tick, receipt.selected_retry_delay_ticks,
    receipt.retry_eligible_tick];
}

function completionFields(receipt) {
  return [receipt.receipt_id, receipt.work_id, receipt.work_version, receipt.lease_id ?? '',
    receipt.idempotency_key, receipt.base_head_sequence, receipt.base_head_digest,
    receipt.journal_sequence, receipt.completion_tick, receipt.outcome,
    receipt.output_digest ?? '', receipt.code ?? '',
    receipt.failure_retryable ?? '', receipt.failure_observed_tick ?? '',
    receipt.selected_retry_delay_ticks ?? ''];
}

function resumeFields(receipt) {
  return [receipt.receipt_id, receipt.work_id, receipt.cancelled_work_version,
    receipt.resumed_work_version, receipt.idempotency_key,
    receipt.vault_owner_receipt.receipt_id, receipt.vault_owner_receipt.signature_digest,
    receipt.cancellation_receipt_id, receipt.cancellation_receipt_signature_digest,
    receipt.cancellation_completion_receipt_id, receipt.cancellation_completion_signature_digest,
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
    payload: command.payload,
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

async function writeControlPlaneState(temporaryRoot, journal) {
  journal.head_sequence = journal.receipts.at(-1)?.journal_sequence ?? 0;
  journal.head_digest = workJournalHeadDigest(journal.receipts);
  const work = journal.work_items[0];
  const schedulerPath = `${temporaryRoot}/contracts/control-plane/scheduler-state.json`;
  const scheduler = JSON.parse(await readFile(schedulerPath));
  scheduler.journal_head_sequence = journal.head_sequence;
  scheduler.journal_head_digest = journal.head_digest;
  const cancellationTicks = new Map(work.cancellation_history
    .map((receipt) => [receipt.receipt_id, receipt.cancellation_tick]));
  const completionTicks = new Map(work.completion_history
    .map((receipt) => [receipt.receipt_id, receipt.completion_tick]));
  scheduler.observation_tick = journal.receipts.reduce((latest, receipt) => Math.max(latest,
    receipt.receipt_kind === 'lease' ? receipt.acquired_tick
      : receipt.receipt_kind === 'start' ? receipt.started_tick
        : receipt.receipt_kind === 'retry' ? receipt.failure_observed_tick
          : receipt.receipt_kind === 'recovery' ? receipt.recovery_tick
            : receipt.receipt_kind === 'cancellation' ? cancellationTicks.get(receipt.receipt_id) ?? latest
              : receipt.receipt_kind === 'completion' ? completionTicks.get(receipt.receipt_id) ?? latest
                : latest), 0);
  scheduler.eligible_queue = ['queued', 'retry_wait'].includes(work.state) ? [{
    work_id: work.work_id,
    work_version: work.work_version,
    priority: 4,
    eligible_tick: work.retry_eligible_tick ?? 0,
    input_digest: work.input_digest,
  }] : [];
  scheduler.active_leases = ['leased', 'executing'].includes(work.state) ? [{
    lease_id: work.lease.lease_id,
    work_id: work.work_id,
    work_version: work.work_version,
    owner_agent_id: work.lease.owner_agent_id,
    acquired_tick: work.lease.acquired_tick,
    expires_tick: work.lease.expires_tick,
    status: 'active',
  }] : [];
  await Promise.all([
    writeFile(`${temporaryRoot}/contracts/control-plane/work-journal.json`, `${JSON.stringify(journal, null, 2)}\n`),
    writeFile(schedulerPath, `${JSON.stringify(scheduler, null, 2)}\n`),
  ]);
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
  const unsupportedVersion = structuredClone(command);
  unsupportedVersion.command_version = 999;
  unsupportedVersion.payload_digest = commandPayloadDigest(unsupportedVersion);
  assert.ok((await validateAgainstSchemaPath(
    packageRoot, 'contracts/schemas/control-channel-command.schema.json', unsupportedVersion,
  )).some(({keyword}) => keyword === 'const'));
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
    ['cancel', {work_id: work.work_id, expected_work_version: work.work_version,
      lease_id: null, reason_code: 'user_requested'},
    {kind: 'work_item', reference_id: work.work_id, version: work.work_version,
      digest: createHash('sha256').update(canonicalJson(work)).digest('hex')}],
    ['enqueue', {work_id: 'work:new-001', work_kind: 'placement_evaluation',
      input_digest: 'a'.repeat(64), dependencies: structuredClone(work.dependencies),
      budget: structuredClone(work.budget)},
    {kind: 'work_journal', reference_id: journal.journal_id, version: journal.head_sequence,
      digest: journal.head_digest}],
  ];
  for (const [kind, payload, base] of cases) {
    const exact = structuredClone(command);
    exact.command_kind = kind;
    exact.payload = payload;
    if (kind === 'cancel') exact.idempotency_key = work.idempotency_key;
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

    if (kind === 'cancel') {
      const wrongIdempotency = structuredClone(exact);
      wrongIdempotency.idempotency_key = 'idempotency:other-001';
      wrongIdempotency.payload_digest = commandPayloadDigest(wrongIdempotency);
      await writeFile(commandPath, `${JSON.stringify(wrongIdempotency, null, 2)}\n`);
      const wrongIdempotencyReport = await buildValidationReport(temporaryRoot);
      assert.ok(wrongIdempotencyReport.checks.find(({id}) => id === 'control-plane-contract').codes
        .includes('control.command_state_invalid'));
    }

    if (kind === 'enqueue') {
      const tamperedPayload = structuredClone(exact);
      tamperedPayload.payload.input_digest = '0'.repeat(64);
      await writeFile(commandPath, `${JSON.stringify(tamperedPayload, null, 2)}\n`);
      const tamperedPayloadReport = await buildValidationReport(temporaryRoot);
      assert.ok(tamperedPayloadReport.checks.find(({id}) => id === 'control-plane-contract').codes
        .includes('control.command_state_invalid'));
    }

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
  replay.payload = {
    work_id: work.work_id, work_kind: work.work_kind, input_digest: work.input_digest,
    dependencies: structuredClone(work.dependencies), budget: structuredClone(work.budget),
  };
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

  const collidingRoot = await copyCommittedPackage();
  const collidingPath = `${collidingRoot}/contracts/control-plane/control-command.json`;
  const colliding = JSON.parse(await readFile(collidingPath));
  colliding.command_kind = 'enqueue';
  colliding.idempotency_key = 'idempotency:other-001';
  colliding.payload = {
    work_id: work.work_id, work_kind: work.work_kind, input_digest: work.input_digest,
    dependencies: structuredClone(work.dependencies), budget: structuredClone(work.budget),
  };
  colliding.base_references = [{kind: 'work_journal', reference_id: journal.journal_id,
    version: journal.head_sequence, digest: journal.head_digest}];
  colliding.payload_digest = commandPayloadDigest(colliding);
  await writeFile(collidingPath, `${JSON.stringify(colliding, null, 2)}\n`);
  const collidingReport = await buildValidationReport(collidingRoot);
  assert.ok(collidingReport.checks.find(({id}) => id === 'control-plane-contract').codes
    .includes('control.command_state_invalid'));

  const resumeRoot = await copyCommittedPackage();
  const resumePath = `${resumeRoot}/contracts/control-plane/control-command.json`;
  const resume = JSON.parse(await readFile(resumePath));
  const cancelledWork = structuredClone(work);
  cancelledWork.state = 'cancelled';
  cancelledWork.work_version = 2;
  cancelledWork.cancellation = null;
  cancelledWork.cancellation_history = [];
  cancelledWork.result = null;
  cancelledWork.completion_history = [];
  cancelledWork.resume_count = 0;
  const resumeJournalPath = `${resumeRoot}/contracts/control-plane/work-journal.json`;
  const resumeJournal = JSON.parse(await readFile(resumeJournalPath));
  resumeJournal.work_items[0] = cancelledWork;
  resume.command_kind = 'resume';
  resume.idempotency_key = 'idempotency:other-001';
  resume.payload = {work_id: cancelledWork.work_id,
    expected_work_version: cancelledWork.work_version, lease_id: null};
  resume.base_references = [{kind: 'work_item', reference_id: cancelledWork.work_id,
    version: cancelledWork.work_version,
    digest: createHash('sha256').update(canonicalJson(cancelledWork)).digest('hex')}];
  resume.payload_digest = commandPayloadDigest(resume);
  await writeFile(resumeJournalPath, `${JSON.stringify(resumeJournal, null, 2)}\n`);
  await writeFile(resumePath, `${JSON.stringify(resume, null, 2)}\n`);
  const wrongResumeIdempotencyReport = await buildValidationReport(resumeRoot);
  assert.ok(wrongResumeIdempotencyReport.checks.find(({id}) => id === 'control-plane-contract').codes
    .includes('control.command_state_invalid'));

  const pairedUnsupported = JSON.parse(await readFile(new URL(
    './scenarios/control-plane/authenticated-local-control-access.json', import.meta.url,
  )));
  pairedUnsupported.subject.document.initial.control_channel.command_version = 2;
  pairedUnsupported.subject.document.action.command_version = 2;
  assert.deepEqual((await observeControlPlaneScenario(pairedUnsupported.subject, packageRoot)).codes,
    ['schema.constraint']);
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
  authenticateScenarioHead(completionFixture.subject.document.initial);
  const completionResult = await observeControlPlaneScenario(completionFixture.subject, packageRoot);
  assert.deepEqual(completionResult.codes, ['control.lease_history_invalid']);

  const leaseFixture = JSON.parse(await readFile(new URL('./scenarios/control-plane/completed-work-not-repeated-restart.json', import.meta.url)));
  leaseFixture.subject.document.initial.prior_lease_receipts[0].signature_digest = '0'.repeat(64);
  authenticateScenarioHead(leaseFixture.subject.document.initial);
  assert.deepEqual((await observeControlPlaneScenario(leaseFixture.subject, packageRoot)).codes,
    ['control.lease_history_invalid']);
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
  authenticateScenarioScheduler(staleFailure.document.initial, staleFailure.document.action.current_tick);
  staleFailure.document.action.expected_scheduler_state_digest =
    staleFailure.document.initial.scheduler_state_digest;
  const failureResult = await observeControlPlaneScenario(staleFailure, packageRoot);
  assert.deepEqual(failureResult.codes, ['control.lease_stale']);

  const earlyRetry = structuredClone(failureFixture.subject);
  const {initial, action} = earlyRetry.document;
  const retryReceipt = {
    receipt_id: 'retry-receipt:early-001', receipt_kind: 'retry', lease_id: initial.work.lease_id,
    work_id: initial.work.work_id, work_version: 4, journal_sequence: 4,
    prior_retry_count: 0, resulting_retry_count: 1, failure_tick: 1,
    selected_retry_delay_ticks: 1000, retry_eligible_tick: 1001,
  };
  Object.assign(retryReceipt, signControlPlaneReceipt('work_retry', retryFields(retryReceipt)));
  initial.prior_retry_receipts = [retryReceipt];
  initial.work = {...initial.work, work_version: 4, state: 'retry_wait', retry_count: 1,
    retry_eligible_tick: 1001,
    lease_id: null, lease_status: null, lease_acquired_tick: null, lease_expires_tick: null,
    owner_agent_id: null};
  authenticateScenarioScheduler(initial, 1000);
  initial.journal_head_sequence = 4;
  authenticateScenarioHead(initial);
  Object.assign(action, {kind: 'retry', actor_role: 'scheduler', expected_work_version: 4,
    lease_id: 'lease:retry-001', current_tick: 1000});
  const retryResult = await observeControlPlaneScenario(earlyRetry, packageRoot);
  assert.deepEqual(retryResult.codes, ['control.retry_not_eligible']);

  const dispatchFixture = JSON.parse(await readFile(new URL('./scenarios/control-plane/dequeue-acknowledges-after-receipt.json', import.meta.url)));
  const retryHistory = JSON.parse(await readFile(new URL('./scenarios/control-plane/retry-ceiling-terminal-failure.json', import.meta.url)));
  const secondRetry = structuredClone(dispatchFixture.subject);
  const secondInitial = secondRetry.document.initial;
  const historyInitial = retryHistory.subject.document.initial;
  secondInitial.prior_lease_receipts = structuredClone(historyInitial.prior_lease_receipts.slice(0, -2));
  secondInitial.prior_retry_receipts = structuredClone(historyInitial.prior_retry_receipts);
  secondInitial.work = {...structuredClone(historyInitial.work), work_version: 7,
    state: 'retry_wait', retry_eligible_tick: historyInitial.prior_retry_receipts.at(-1).retry_eligible_tick,
    lease_id: null, lease_status: null, lease_acquired_tick: null, lease_expires_tick: null,
    owner_agent_id: null};
  secondInitial.scheduler_observed_tick = secondInitial.work.retry_eligible_tick;
  secondInitial.active_lease_ids = [];
  secondInitial.active_work_count = 0;
  secondInitial.scheduler_active_lease_receipts = [];
  secondInitial.scheduler_state_digest = schedulerStateDigest([]);
  secondInitial.journal_head_sequence = 7;
  authenticateScenarioHead(secondInitial);
  Object.assign(secondRetry.document.action, {kind: 'retry', actor_role: 'scheduler',
    expected_work_version: 7, expected_journal_head_sequence: 7,
    expected_journal_head_digest: secondInitial.journal_head_digest,
    expected_scheduler_state_digest: secondInitial.scheduler_state_digest,
    lease_id: 'lease:retry-002', current_tick: secondInitial.work.retry_eligible_tick});
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
      subject.document.initial.scheduler_active_lease_receipts = subject.document.initial.active_lease_ids
        .map((leaseId, index) => {
          const receipt = {
            receipt_id: `scheduler-lease-receipt:active-${index + 1}`,
            vault_id: subject.document.initial.vault_id, lease_id: leaseId,
            work_id: `work:active-${index + 1}`, work_version: 1,
            owner_agent_id: subject.document.initial.persistent_agent_id,
            acquired_tick: 1, expires_tick: 301, status: 'active',
          };
          return {...receipt, ...signControlPlaneReceipt(
            'scheduler_active_lease', schedulerLeaseFields(receipt),
          )};
        });
      subject.document.initial.active_work_count = 8;
      const prefix = subject.document.initial.journal_prefix_receipt;
      prefix.head_sequence = 8;
      prefix.head_digest = 'f'.repeat(64);
      prefix.active_leases = subject.document.initial.scheduler_active_lease_receipts.map((receipt) => ({
        lease_id: receipt.lease_id, work_id: receipt.work_id, work_version: receipt.work_version,
        owner_agent_id: receipt.owner_agent_id, acquired_tick: receipt.acquired_tick,
        expires_tick: receipt.expires_tick, status: receipt.status,
      }));
      Object.assign(prefix, signControlPlaneReceipt(
        'work_journal_prefix', journalPrefixFields(prefix),
      ));
      const enqueue = subject.document.initial.work.enqueue_receipt;
      Object.assign(enqueue, {
        base_head_sequence: prefix.head_sequence, base_head_digest: prefix.head_digest,
        journal_sequence: prefix.head_sequence + 1,
      });
      Object.assign(enqueue, signControlPlaneReceipt('work_enqueue', [
        enqueue.receipt_id, enqueue.work_id, enqueue.work_version, enqueue.idempotency_key,
        enqueue.input_digest, enqueue.base_head_sequence, enqueue.base_head_digest,
        enqueue.journal_sequence,
      ]));
      authenticateScenarioHead(subject.document.initial);
      subject.document.action.expected_journal_head_sequence = subject.document.initial.journal_head_sequence;
      subject.document.action.expected_journal_head_digest = subject.document.initial.journal_head_digest;
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

  const reusedPrefixLease = structuredClone(fixture.subject);
  const reusedInitial = reusedPrefixLease.document.initial;
  const reusedAction = reusedPrefixLease.document.action;
  const prefix = reusedInitial.journal_prefix_receipt;
  const prefixLease = {
    lease_id: reusedAction.lease_id, work_id: 'work:other-001', work_version: 1,
    owner_agent_id: reusedInitial.persistent_agent_id,
    acquired_tick: 1, expires_tick: 301, status: 'active',
  };
  Object.assign(prefix, {head_sequence: 1, head_digest: 'f'.repeat(64), active_leases: [prefixLease]});
  Object.assign(prefix, signControlPlaneReceipt('work_journal_prefix', journalPrefixFields(prefix)));
  const enqueueReceipt = reusedInitial.work.enqueue_receipt;
  Object.assign(enqueueReceipt, {
    base_head_sequence: 1, base_head_digest: prefix.head_digest, journal_sequence: 2,
  });
  Object.assign(enqueueReceipt, signControlPlaneReceipt('work_enqueue', [
    enqueueReceipt.receipt_id, enqueueReceipt.work_id, enqueueReceipt.work_version,
    enqueueReceipt.idempotency_key, enqueueReceipt.input_digest,
    enqueueReceipt.base_head_sequence, enqueueReceipt.base_head_digest,
    enqueueReceipt.journal_sequence,
  ]));
  reusedInitial.journal_head_sequence = 2;
  authenticateScenarioHead(reusedInitial);
  const schedulerReceipt = {
    receipt_id: 'scheduler-lease-receipt:reused-prefix-001',
    vault_id: reusedInitial.vault_id, ...prefixLease,
  };
  Object.assign(schedulerReceipt, signControlPlaneReceipt(
    'scheduler_active_lease', schedulerLeaseFields(schedulerReceipt),
  ));
  Object.assign(reusedInitial, {
    active_lease_ids: [reusedAction.lease_id], active_work_count: 1,
    scheduler_active_lease_receipts: [schedulerReceipt],
    scheduler_state_digest: schedulerStateDigest([reusedAction.lease_id]),
  });
  Object.assign(reusedAction, {
    expected_journal_head_sequence: reusedInitial.journal_head_sequence,
    expected_journal_head_digest: reusedInitial.journal_head_digest,
    expected_scheduler_state_digest: reusedInitial.scheduler_state_digest,
  });
  assert.deepEqual((await observeControlPlaneScenario(reusedPrefixLease, packageRoot)).codes,
    ['control.lease_identity_conflict']);

  const reversedLiveDispatch = structuredClone(fixture.subject);
  const reversedInitial = reversedLiveDispatch.document.initial;
  const reversedAction = reversedLiveDispatch.document.action;
  const priorLease = {
    receipt_id: 'lease-receipt:live-clock-001', receipt_kind: 'lease',
    lease_id: 'lease:live-clock-001', work_id: reversedInitial.work.work_id,
    work_version: 2, journal_sequence: 2,
    owner_agent_id: reversedInitial.persistent_agent_id,
    acquired_tick: 100, expires_tick: 400, started_tick: null, status: 'active',
  };
  Object.assign(priorLease, signControlPlaneReceipt('work_lease', leaseFields(priorLease)));
  const priorRecovery = {
    receipt_id: 'recovery-receipt:live-clock-001', receipt_kind: 'recovery',
    lease_id: priorLease.lease_id, work_id: reversedInitial.work.work_id,
    work_version: 3, journal_sequence: 3, prior_state: 'leased', prior_retry_count: 0,
    recovery_interruption_count: 1, resulting_retry_count: 0, recovery_tick: 400,
    recovery_lease_status: 'expired', recovery_decision: 'requeue',
    selected_retry_delay_ticks: null, resulting_state: 'queued',
  };
  Object.assign(priorRecovery, signControlPlaneReceipt(
    'work_recovery', recoveryFields(priorRecovery),
  ));
  reversedInitial.prior_lease_receipts = [priorLease];
  reversedInitial.prior_recovery_receipts = [priorRecovery];
  Object.assign(reversedInitial.work, {
    work_version: 3, state: 'queued', recovery_interruption_count: 1,
    lease_id: null, lease_status: null, lease_acquired_tick: null,
    lease_expires_tick: null, owner_agent_id: null,
  });
  reversedInitial.journal_head_sequence = 3;
  authenticateScenarioHead(reversedInitial);
  Object.assign(reversedAction, {
    expected_work_version: 3,
    expected_journal_head_sequence: 3,
    expected_journal_head_digest: reversedInitial.journal_head_digest,
    lease_id: 'lease:live-clock-new-001', current_tick: 1,
  });
  authenticateScenarioScheduler(reversedInitial, reversedAction.current_tick);
  reversedAction.expected_scheduler_state_digest = reversedInitial.scheduler_state_digest;
  assert.deepEqual((await observeControlPlaneScenario(reversedLiveDispatch, packageRoot)).codes,
    ['control.lease_tick_stale']);
});

test('stateful dependency and Scheduler snapshots are derived from durable Work evidence', async () => {
  const fixture = JSON.parse(await readFile(new URL(
    './scenarios/control-plane/dequeue-acknowledges-after-receipt.json', import.meta.url,
  )));
  const forgedDependency = structuredClone(fixture.subject);
  const dependency = forgedDependency.document.initial.dependency_state_receipt.dependencies[0];
  dependency.digest = 'a'.repeat(64);
  const dependencyDigest = createHash('sha256').update(canonicalJson(
    forgedDependency.document.initial.dependency_state_receipt.dependencies,
  )).digest('hex');
  forgedDependency.document.initial.dependency_state_digest = dependencyDigest;
  forgedDependency.document.action.expected_dependency_state_digest = dependencyDigest;
  Object.assign(forgedDependency.document.initial.dependency_state_receipt,
    signControlPlaneReceipt('dependency_state', [
      forgedDependency.document.initial.dependency_state_receipt.receipt_id, dependencyDigest,
    ]));
  assert.deepEqual((await observeControlPlaneScenario(forgedDependency, packageRoot)).codes,
    ['control.dependency_evidence_invalid']);

  const relabelledVersion = structuredClone(fixture.subject);
  relabelledVersion.document.initial.work.dependencies[0].version = 2;
  relabelledVersion.document.initial.dependency_state_receipt.dependencies[0].version = 2;
  const relabelledDigest = createHash('sha256').update(canonicalJson(
    relabelledVersion.document.initial.dependency_state_receipt.dependencies,
  )).digest('hex');
  relabelledVersion.document.initial.dependency_state_digest = relabelledDigest;
  relabelledVersion.document.action.expected_dependency_state_digest = relabelledDigest;
  Object.assign(relabelledVersion.document.initial.dependency_state_receipt,
    signControlPlaneReceipt('dependency_state', [
      relabelledVersion.document.initial.dependency_state_receipt.receipt_id, relabelledDigest,
    ]));
  assert.deepEqual((await observeControlPlaneScenario(relabelledVersion, packageRoot)).codes,
    ['control.dependency_evidence_invalid']);

  const relabelledHead = structuredClone(fixture.subject);
  relabelledHead.document.initial.semantic_state_digest = 'a'.repeat(64);
  relabelledHead.document.initial.work.dependencies[0].digest = 'a'.repeat(64);
  relabelledHead.document.initial.dependency_state_receipt.dependencies[0].digest = 'a'.repeat(64);
  const relabelledHeadDigest = createHash('sha256').update(canonicalJson(
    relabelledHead.document.initial.dependency_state_receipt.dependencies,
  )).digest('hex');
  relabelledHead.document.initial.dependency_state_digest = relabelledHeadDigest;
  relabelledHead.document.action.expected_dependency_state_digest = relabelledHeadDigest;
  Object.assign(relabelledHead.document.initial.dependency_state_receipt,
    signControlPlaneReceipt('dependency_state', [
      relabelledHead.document.initial.dependency_state_receipt.receipt_id, relabelledHeadDigest,
    ]));
  assert.deepEqual((await observeControlPlaneScenario(relabelledHead, packageRoot)).codes,
    ['schema.constraint']);

  const prefixCollision = structuredClone(fixture.subject);
  const prefix = prefixCollision.document.initial.journal_prefix_receipt;
  Object.assign(prefix, {head_sequence: 1, head_digest: 'f'.repeat(64), active_leases: [{
    lease_id: 'lease:prior-001', work_id: prefixCollision.document.initial.work.work_id,
    work_version: 1, owner_agent_id: prefixCollision.document.initial.persistent_agent_id,
    acquired_tick: 1, expires_tick: 301, status: 'active',
  }]});
  Object.assign(prefix, signControlPlaneReceipt('work_journal_prefix', journalPrefixFields(prefix)));
  const enqueue = prefixCollision.document.initial.work.enqueue_receipt;
  Object.assign(enqueue, {base_head_sequence: 1, base_head_digest: prefix.head_digest, journal_sequence: 2});
  Object.assign(enqueue, signControlPlaneReceipt('work_enqueue', [
    enqueue.receipt_id, enqueue.work_id, enqueue.work_version, enqueue.idempotency_key,
    enqueue.input_digest, enqueue.base_head_sequence, enqueue.base_head_digest, enqueue.journal_sequence,
  ]));
  authenticateScenarioHead(prefixCollision.document.initial);
  prefixCollision.document.action.expected_journal_head_sequence = prefixCollision.document.initial.journal_head_sequence;
  prefixCollision.document.action.expected_journal_head_digest = prefixCollision.document.initial.journal_head_digest;
  assert.deepEqual((await observeControlPlaneScenario(prefixCollision, packageRoot)).codes,
    ['control.lease_history_invalid']);

  const futurePrefixLease = structuredClone(fixture.subject);
  const futureInitial = futurePrefixLease.document.initial;
  const futureAction = futurePrefixLease.document.action;
  const futurePrefix = futureInitial.journal_prefix_receipt;
  Object.assign(futurePrefix, {head_sequence: 1, head_digest: 'e'.repeat(64), active_leases: [{
    lease_id: 'lease:future-prefix-001', work_id: 'work:other-001', work_version: 1,
    owner_agent_id: futureInitial.persistent_agent_id,
    acquired_tick: 999701, expires_tick: 1000001, status: 'active',
  }]});
  Object.assign(futurePrefix, signControlPlaneReceipt(
    'work_journal_prefix', journalPrefixFields(futurePrefix),
  ));
  const futureEnqueue = futureInitial.work.enqueue_receipt;
  Object.assign(futureEnqueue, {
    base_head_sequence: 1, base_head_digest: futurePrefix.head_digest, journal_sequence: 2,
  });
  Object.assign(futureEnqueue, signControlPlaneReceipt('work_enqueue', [
    futureEnqueue.receipt_id, futureEnqueue.work_id, futureEnqueue.work_version,
    futureEnqueue.idempotency_key, futureEnqueue.input_digest,
    futureEnqueue.base_head_sequence, futureEnqueue.base_head_digest,
    futureEnqueue.journal_sequence,
  ]));
  futureInitial.journal_head_sequence = 2;
  authenticateScenarioHead(futureInitial);
  Object.assign(futureAction, {
    expected_journal_head_sequence: 2,
    expected_journal_head_digest: futureInitial.journal_head_digest,
  });
  authenticateScenarioScheduler(futureInitial, futureAction.current_tick);
  futureAction.expected_scheduler_state_digest = futureInitial.scheduler_state_digest;
  assert.deepEqual((await observeControlPlaneScenario(futurePrefixLease, packageRoot)).codes,
    ['control.lease_history_invalid']);

  const phantomLease = structuredClone(fixture.subject);
  const phantomReceipt = {
    receipt_id: 'scheduler-lease-receipt:phantom-001',
    vault_id: phantomLease.document.initial.vault_id, lease_id: 'lease:phantom-001',
    work_id: 'work:phantom-001', work_version: 1,
    owner_agent_id: phantomLease.document.initial.persistent_agent_id,
    acquired_tick: 1, expires_tick: 301, status: 'active',
  };
  Object.assign(phantomReceipt, signControlPlaneReceipt(
    'scheduler_active_lease', schedulerLeaseFields(phantomReceipt),
  ));
  phantomLease.document.initial.active_lease_ids.push(phantomReceipt.lease_id);
  phantomLease.document.initial.scheduler_active_lease_receipts.push(phantomReceipt);
  phantomLease.document.initial.active_work_count += 1;
  phantomLease.document.initial.scheduler_state_digest = schedulerStateDigest(
    phantomLease.document.initial.active_lease_ids,
  );
  phantomLease.document.action.expected_scheduler_state_digest =
    phantomLease.document.initial.scheduler_state_digest;
  assert.deepEqual((await observeControlPlaneScenario(phantomLease, packageRoot)).codes,
    ['control.scheduler_base_stale']);
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
  authenticateScenarioHead(fixture.subject.document.initial);

  assert.deepEqual((await observeControlPlaneScenario(fixture.subject, packageRoot)).codes,
    ['control.lease_history_invalid']);

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
    laterLease.acquired_tick, laterLease.expires_tick, laterLease.status,
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
    ['control.lease_history_invalid']);
});

test('leased work requires authenticated durable lease evidence', async () => {
  const arbitraryHead = JSON.parse(await readFile(new URL(
    './scenarios/control-plane/first-retry-recorded.json', import.meta.url,
  )));
  arbitraryHead.subject.document.initial.journal_head_digest = 'a'.repeat(64);
  arbitraryHead.subject.document.initial.journal_head_receipt.head_digest = 'a'.repeat(64);
  Object.assign(arbitraryHead.subject.document.initial.journal_head_receipt, signControlPlaneReceipt(
    'work_journal_head', journalHeadFields(arbitraryHead.subject.document.initial.journal_head_receipt),
  ));
  assert.deepEqual((await observeControlPlaneScenario(arbitraryHead.subject, packageRoot)).codes,
    ['control.lease_history_invalid']);

  const gappedHistory = JSON.parse(await readFile(new URL(
    './scenarios/control-plane/completed-work-not-repeated-restart.json', import.meta.url,
  )));
  const gappedInitial = gappedHistory.subject.document.initial;
  gappedInitial.work.completion_receipt.journal_sequence = 5;
  Object.assign(gappedInitial.work.completion_receipt, signControlPlaneReceipt(
    'work_completion', completionFields(gappedInitial.work.completion_receipt),
  ));
  gappedInitial.work.completion_history = [structuredClone(gappedInitial.work.completion_receipt)];
  gappedInitial.journal_head_sequence = 5;
  gappedInitial.journal_head_digest = scenarioLifecycleDigest(gappedInitial);
  Object.assign(gappedInitial.journal_head_receipt, {
    head_sequence: 5, head_digest: gappedInitial.journal_head_digest,
  });
  Object.assign(gappedInitial.journal_head_receipt, signControlPlaneReceipt(
    'work_journal_head', journalHeadFields(gappedInitial.journal_head_receipt),
  ));
  Object.assign(gappedHistory.subject.document.action, {
    expected_journal_head_sequence: 5,
    expected_journal_head_digest: gappedInitial.journal_head_digest,
  });
  assert.deepEqual((await observeControlPlaneScenario(gappedHistory.subject, packageRoot)).codes,
    ['control.lease_history_invalid']);

  const inactiveCompletion = JSON.parse(await readFile(new URL(
    './scenarios/control-plane/completed-work-not-repeated-restart.json', import.meta.url,
  )));
  for (const receipt of inactiveCompletion.subject.document.initial.prior_lease_receipts) {
    receipt.status = 'expired';
    Object.assign(receipt, signControlPlaneReceipt('work_lease', leaseFields(receipt)));
  }
  authenticateScenarioHead(inactiveCompletion.subject.document.initial);
  assert.deepEqual((await observeControlPlaneScenario(inactiveCompletion.subject, packageRoot)).codes,
    ['schema.constraint']);

  const fixture = JSON.parse(await readFile(new URL('./scenarios/control-plane/first-retry-recorded.json', import.meta.url)));
  fixture.subject.document.initial.prior_lease_receipts[0].signature_digest = '0'.repeat(64);
  authenticateScenarioHead(fixture.subject.document.initial);
  assert.deepEqual((await observeControlPlaneScenario(fixture.subject, packageRoot)).codes,
    ['control.lease_history_invalid']);

  const staleCurrentTicks = JSON.parse(await readFile(new URL('./scenarios/control-plane/first-retry-recorded.json', import.meta.url)));
  staleCurrentTicks.subject.document.initial.work.lease_acquired_tick += 1;
  staleCurrentTicks.subject.document.initial.work.lease_expires_tick += 1;
  assert.deepEqual((await observeControlPlaneScenario(staleCurrentTicks.subject, packageRoot)).codes,
    ['control.lease_history_invalid']);

  const staleSignedTicks = JSON.parse(await readFile(new URL('./scenarios/control-plane/first-retry-recorded.json', import.meta.url)));
  const signedLease = staleSignedTicks.subject.document.initial.prior_lease_receipts[0];
  signedLease.acquired_tick += 1;
  signedLease.expires_tick += 1;
  Object.assign(signedLease, signControlPlaneReceipt('work_lease', leaseFields(signedLease)));
  authenticateScenarioHead(staleSignedTicks.subject.document.initial);
  assert.deepEqual((await observeControlPlaneScenario(staleSignedTicks.subject, packageRoot)).codes,
    ['control.lease_history_invalid']);

  const duplicateAcquisition = JSON.parse(await readFile(new URL('./scenarios/control-plane/completed-work-not-repeated-restart.json', import.meta.url)));
  const duplicateLease = structuredClone(duplicateAcquisition.subject.document.initial.prior_lease_receipts[0]);
  duplicateLease.receipt_id = 'lease-receipt:duplicate-001';
  Object.assign(duplicateLease, signControlPlaneReceipt('work_lease', leaseFields(duplicateLease)));
  duplicateAcquisition.subject.document.initial.prior_lease_receipts.push(duplicateLease);
  assert.deepEqual((await observeControlPlaneScenario(duplicateAcquisition.subject, packageRoot)).codes,
    ['control.lease_history_invalid']);

  const reusedLease = JSON.parse(await readFile(new URL(
    './scenarios/control-plane/retry-ceiling-terminal-failure.json', import.meta.url,
  )));
  const reusedInitial = reusedLease.subject.document.initial;
  const firstLeaseId = reusedInitial.prior_lease_receipts[0].lease_id;
  for (const receipt of reusedInitial.prior_lease_receipts.slice(2, 4)) {
    receipt.lease_id = firstLeaseId;
    Object.assign(receipt, signControlPlaneReceipt('work_lease', leaseFields(receipt)));
  }
  reusedInitial.prior_retry_receipts[1].lease_id = firstLeaseId;
  Object.assign(reusedInitial.prior_retry_receipts[1], signControlPlaneReceipt(
    'work_retry', retryFields(reusedInitial.prior_retry_receipts[1]),
  ));
  authenticateScenarioHead(reusedInitial);
  assert.deepEqual((await observeControlPlaneScenario(reusedLease.subject, packageRoot)).codes,
    ['control.lease_history_invalid']);

  const orphanAcquisition = JSON.parse(await readFile(new URL('./scenarios/control-plane/completed-work-not-repeated-restart.json', import.meta.url)));
  const orphanLease = structuredClone(orphanAcquisition.subject.document.initial.prior_lease_receipts[0]);
  Object.assign(orphanLease, {
    receipt_id: 'lease-receipt:orphan-001', lease_id: 'lease:orphan-001',
    work_id: 'work:other-001', signature_digest: '0'.repeat(64),
  });
  orphanAcquisition.subject.document.initial.prior_lease_receipts.push(orphanLease);
  assert.deepEqual((await observeControlPlaneScenario(orphanAcquisition.subject, packageRoot)).codes,
    ['control.lease_history_invalid']);
});

test('recovery exhaustion commits an authenticated terminal failure', async () => {
  const fixture = JSON.parse(await readFile(new URL('./scenarios/control-plane/in-flight-work-recovers-agent-crash.json', import.meta.url)));

  function installPriorRecoveryChain(subject, count) {
    const {initial, action} = subject.document;
    const acquisitions = [];
    const recoveries = [];
    for (let index = 1; index <= count; index += 1) {
      const acquiredTick = index * 400;
      const acquisition = {
        receipt_id: `lease-receipt:prior-${index}`, receipt_kind: 'lease',
        lease_id: `lease:prior-${index}`, work_id: initial.work.work_id,
        work_version: index * 2, journal_sequence: index * 2,
        owner_agent_id: initial.persistent_agent_id, acquired_tick: acquiredTick,
        expires_tick: acquiredTick + 300, started_tick: null, status: 'active',
      };
      Object.assign(acquisition, signControlPlaneReceipt('work_lease', leaseFields(acquisition)));
      acquisitions.push(acquisition);
      const recovery = {
        receipt_id: `recovery-receipt:prior-${index}`, receipt_kind: 'recovery',
        lease_id: acquisition.lease_id, work_id: initial.work.work_id,
        work_version: index * 2 + 1, journal_sequence: index * 2 + 1,
        prior_state: 'leased', prior_retry_count: 0, recovery_interruption_count: index,
        resulting_retry_count: 0, recovery_tick: acquisition.expires_tick,
        recovery_lease_status: 'expired', recovery_decision: 'requeue',
        selected_retry_delay_ticks: null, resulting_state: 'queued',
      };
      Object.assign(recovery, signControlPlaneReceipt('work_recovery', recoveryFields(recovery)));
      recoveries.push(recovery);
    }
    const currentLease = structuredClone(initial.prior_lease_receipts[0]);
    const currentVersion = count * 2 + 2;
    const currentSequence = count * 2 + 2;
    const acquiredTick = (count + 1) * 400;
    Object.assign(currentLease, {
      receipt_id: 'lease-receipt:current-001', work_version: currentVersion,
      journal_sequence: currentSequence, acquired_tick: acquiredTick,
      expires_tick: acquiredTick + 300, started_tick: null, status: 'active',
    });
    Object.assign(currentLease, signControlPlaneReceipt('work_lease', leaseFields(currentLease)));
    const currentStart = {
      ...structuredClone(currentLease), receipt_id: 'lease-receipt:current-start-001',
      receipt_kind: 'start', work_version: currentVersion + 1,
      journal_sequence: currentSequence + 1, started_tick: acquiredTick,
    };
    Object.assign(currentStart, signControlPlaneReceipt('work_lease', leaseFields(currentStart)));
    initial.prior_lease_receipts = [...acquisitions, currentLease, currentStart];
    initial.prior_recovery_receipts = recoveries;
    Object.assign(initial.work, {
      work_version: currentVersion + 1, recovery_interruption_count: count,
      lease_acquired_tick: currentLease.acquired_tick,
      lease_expires_tick: currentLease.expires_tick, lease_status: 'active',
    });
    initial.journal_head_sequence = currentSequence + 1;
    authenticateScenarioHead(initial);
    Object.assign(action, {
      expected_work_version: currentVersion + 1,
      expected_journal_head_sequence: currentSequence + 1,
      expected_journal_head_digest: initial.journal_head_digest,
      recovery_tick: currentLease.expires_tick,
      interruption_count: count + 1,
    });
    authenticateScenarioScheduler(initial, action.recovery_tick);
    action.expected_scheduler_state_digest = initial.scheduler_state_digest;
  }

  const reversedAttempt = structuredClone(fixture.subject);
  installPriorRecoveryChain(reversedAttempt, 1);
  const reversedInitial = reversedAttempt.document.initial;
  const reversedAction = reversedAttempt.document.action;
  const reversedAcquisition = reversedInitial.prior_lease_receipts.at(-2);
  const reversedStart = reversedInitial.prior_lease_receipts.at(-1);
  Object.assign(reversedAcquisition, {acquired_tick: 0, expires_tick: 300});
  Object.assign(reversedAcquisition, signControlPlaneReceipt(
    'work_lease', leaseFields(reversedAcquisition),
  ));
  Object.assign(reversedStart, {acquired_tick: 0, expires_tick: 300, started_tick: 0});
  Object.assign(reversedStart, signControlPlaneReceipt('work_lease', leaseFields(reversedStart)));
  Object.assign(reversedInitial.work, {lease_acquired_tick: 0, lease_expires_tick: 300});
  authenticateScenarioHead(reversedInitial);
  Object.assign(reversedAction, {
    expected_journal_head_digest: reversedInitial.journal_head_digest,
    recovery_tick: 300,
  });
  authenticateScenarioScheduler(reversedInitial, reversedAction.recovery_tick);
  reversedAction.expected_scheduler_state_digest = reversedInitial.scheduler_state_digest;
  assert.deepEqual((await observeControlPlaneScenario(reversedAttempt, packageRoot)).codes,
    ['control.lease_history_invalid']);

  const recoveryExhausted = structuredClone(fixture.subject);
  installPriorRecoveryChain(recoveryExhausted, 2);
  const recoveryResult = await observeControlPlaneScenario(recoveryExhausted, packageRoot);
  assert.equal(recoveryResult.verdict, 'pass');
  assert.equal(recoveryResult.terminal_state, 'failed');
  assert.equal(recoveryResult.outputs.includes('work_state:failed'), true);
  assert.deepEqual(recoveryResult.filesystem_effects,
    ['append durable Work Recovery record', 'append durable terminal completion record']);
  assert.deepEqual(recoveryResult.receipts.map((receipt) => receipt.split(':')[0]),
    ['WorkRecoveryReceipt', 'CompletionReceipt']);
  assert.equal(recoveryResult.codes.length, 0);

  const simultaneousFailure = structuredClone(fixture.subject);
  installPriorRecoveryChain(simultaneousFailure, 2);
  const simultaneousInitial = simultaneousFailure.document.initial;
  const simultaneousAction = simultaneousFailure.document.action;
  const simultaneousAcquisition = simultaneousInitial.prior_lease_receipts.at(-2);
  const simultaneousStart = simultaneousInitial.prior_lease_receipts.at(-1);
  Object.assign(simultaneousAcquisition, {acquired_tick: 999698, expires_tick: 999998});
  Object.assign(simultaneousAcquisition, signControlPlaneReceipt(
    'work_lease', leaseFields(simultaneousAcquisition),
  ));
  Object.assign(simultaneousStart, {
    acquired_tick: 999698, expires_tick: 999998, started_tick: 999698,
  });
  Object.assign(simultaneousStart, signControlPlaneReceipt('work_lease', leaseFields(simultaneousStart)));
  Object.assign(simultaneousInitial.work, {
    lease_acquired_tick: 999698, lease_expires_tick: 999998,
  });
  authenticateScenarioHead(simultaneousInitial);
  Object.assign(simultaneousAction, {
    expected_journal_head_sequence: simultaneousInitial.journal_head_sequence,
    expected_journal_head_digest: simultaneousInitial.journal_head_digest,
    recovery_tick: 999998,
  });
  authenticateScenarioScheduler(simultaneousInitial, simultaneousAction.recovery_tick);
  simultaneousAction.expected_scheduler_state_digest = simultaneousInitial.scheduler_state_digest;
  const simultaneousResult = await observeControlPlaneScenario(simultaneousFailure, packageRoot);
  assert.equal(simultaneousResult.verdict, 'pass', JSON.stringify(simultaneousResult));
  assert.ok(simultaneousResult.outputs.includes(
    'recovery interruption ceiling produced terminal failure',
  ));

  const retryExhausted = structuredClone(fixture.subject);
  const retryHistoryFixture = JSON.parse(await readFile(new URL(
    './scenarios/control-plane/retry-ceiling-terminal-failure.json', import.meta.url,
  )));
  Object.assign(retryExhausted.document.initial, {
    work: structuredClone(retryHistoryFixture.subject.document.initial.work),
    prior_lease_receipts: structuredClone(retryHistoryFixture.subject.document.initial.prior_lease_receipts),
    prior_retry_receipts: structuredClone(retryHistoryFixture.subject.document.initial.prior_retry_receipts),
  });
  const retryInitial = retryExhausted.document.initial;
  retryInitial.work.lease_status = 'active';
  retryInitial.journal_head_sequence = 9;
  authenticateScenarioHead(retryInitial);
  Object.assign(retryExhausted.document.action, {
    expected_work_version: retryInitial.work.work_version,
    expected_journal_head_sequence: retryInitial.journal_head_sequence,
    expected_journal_head_digest: retryInitial.journal_head_digest,
    lease_id: retryInitial.work.lease_id,
    recovery_tick: retryInitial.work.lease_expires_tick,
    interruption_count: 1,
  });
  authenticateScenarioScheduler(retryInitial, retryExhausted.document.action.recovery_tick);
  retryExhausted.document.action.expected_scheduler_state_digest = retryInitial.scheduler_state_digest;
  const retryResult = await observeControlPlaneScenario(retryExhausted, packageRoot);
  assert.equal(retryResult.verdict, 'pass');
  assert.equal(retryResult.terminal_state, 'failed');

  const persistedOverflow = JSON.parse(await readFile(new URL('./scenarios/control-plane/completed-work-not-repeated-restart.json', import.meta.url)));
  const persistedInitial = persistedOverflow.subject.document.initial;
  const persistedWork = persistedInitial.work;
  Object.assign(persistedWork, {state: 'failed', retry_count: 0, recovery_interruption_count: 1});
  const persistedRecovery = {
    receipt_id: 'recovery-receipt:overflow-001', receipt_kind: 'recovery',
    lease_id: 'lease:001', work_id: persistedWork.work_id, work_version: 4,
    journal_sequence: 4, prior_state: 'executing', prior_retry_count: 0,
    recovery_interruption_count: 1, resulting_retry_count: 0, recovery_tick: 999000,
    recovery_lease_status: 'expired', recovery_decision: 'fail',
    selected_retry_delay_ticks: 1000, resulting_state: 'failed',
  };
  Object.assign(persistedRecovery, signControlPlaneReceipt(
    'work_recovery', recoveryFields(persistedRecovery),
  ));
  persistedInitial.prior_recovery_receipts = [persistedRecovery];
  Object.assign(persistedWork.completion_receipt, {
    work_version: 4, journal_sequence: 5, outcome: 'failed', output_digest: null,
    code: 'control.retry_tick_overflow', failure_retryable: true,
    failure_observed_tick: 999000, selected_retry_delay_ticks: 1000,
    completion_tick: 999000,
  });
  persistedWork.completion_history = [persistedWork.completion_receipt];
  Object.assign(persistedWork.completion_receipt, {
    base_head_sequence: 4,
    base_head_digest: scenarioLifecycleDigestAtSequence(persistedInitial, 4),
  });
  Object.assign(persistedWork.completion_receipt, signControlPlaneReceipt(
    'work_completion', completionFields(persistedWork.completion_receipt),
  ));
  persistedWork.completion_history = [structuredClone(persistedWork.completion_receipt)];
  persistedInitial.journal_head_sequence = 5;
  authenticateScenarioHead(persistedInitial);
  authenticateScenarioScheduler(persistedInitial, persistedWork.completion_receipt.completion_tick);
  persistedOverflow.subject.document.action.expected_journal_head_sequence = 5;
  persistedOverflow.subject.document.action.expected_journal_head_digest = persistedInitial.journal_head_digest;
  const persistedOverflowResult = await observeControlPlaneScenario(persistedOverflow.subject, packageRoot);
  assert.equal(persistedOverflowResult.verdict, 'pass', JSON.stringify(persistedOverflowResult));
  assert.equal(persistedOverflowResult.terminal_state, 'ready');

  persistedInitial.prior_recovery_receipts = [];
  assert.deepEqual((await observeControlPlaneScenario(persistedOverflow.subject, packageRoot)).codes,
    ['control.lease_history_invalid']);

  const isolatedCeiling = structuredClone(persistedOverflow.subject);
  const isolatedInitial = isolatedCeiling.document.initial;
  const isolatedWork = isolatedInitial.work;
  Object.assign(isolatedWork, {recovery_interruption_count: 3});
  Object.assign(isolatedWork.completion_receipt, {
    code: 'control.recovery_ceiling_exceeded', failure_retryable: null,
    failure_observed_tick: null, selected_retry_delay_ticks: null, completion_tick: 999000,
  });
  Object.assign(isolatedWork.completion_receipt, signControlPlaneReceipt(
    'work_completion', completionFields(isolatedWork.completion_receipt),
  ));
  isolatedWork.completion_history = [structuredClone(isolatedWork.completion_receipt)];
  const isolatedRecovery = {
    ...persistedRecovery, receipt_id: 'recovery-receipt:isolated-003',
    recovery_interruption_count: 3, recovery_decision: 'fail',
    selected_retry_delay_ticks: null, resulting_state: 'failed',
  };
  Object.assign(isolatedRecovery, signControlPlaneReceipt(
    'work_recovery', recoveryFields(isolatedRecovery),
  ));
  isolatedInitial.prior_recovery_receipts = [isolatedRecovery];
  authenticateScenarioHead(isolatedInitial);
  assert.deepEqual((await observeControlPlaneScenario(isolatedCeiling, packageRoot)).codes,
    ['control.lease_history_invalid']);
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

  const expiryBoundary = JSON.parse(await readFile(new URL(
    './scenarios/control-plane/cancellation-during-execution-durable.json', import.meta.url,
  )));
  expiryBoundary.subject.document.action.current_tick =
    expiryBoundary.subject.document.initial.work.lease_expires_tick;
  authenticateScenarioScheduler(
    expiryBoundary.subject.document.initial, expiryBoundary.subject.document.action.current_tick,
  );
  expiryBoundary.subject.document.action.expected_scheduler_state_digest =
    expiryBoundary.subject.document.initial.scheduler_state_digest;
  authenticateVaultOwnerAction(expiryBoundary.subject);
  assert.deepEqual((await observeControlPlaneScenario(expiryBoundary.subject, packageRoot)).codes,
    ['control.lease_stale']);

  const crossVault = JSON.parse(await readFile(new URL(
    './scenarios/control-plane/cancellation-before-dispatch-durable.json', import.meta.url,
  )));
  crossVault.subject.document.initial.control_channel.vault_id = 'vault:other-001';
  assert.deepEqual((await observeControlPlaneScenario(crossVault.subject, packageRoot)).codes,
    ['schema.constraint']);

  const pairedCrossVault = structuredClone(crossVault);
  pairedCrossVault.subject.document.initial.vault_id = 'vault:other-001';
  assert.deepEqual((await observeControlPlaneScenario(pairedCrossVault.subject, packageRoot)).codes,
    ['schema.constraint']);

  const expiredPersistedCancellation = structuredClone(cancelled);
  const expiredInitial = expiredPersistedCancellation.document.initial;
  const expiredWork = expiredInitial.work;
  const executionFixture = JSON.parse(await readFile(new URL('./scenarios/control-plane/cancellation-during-execution-durable.json', import.meta.url)));
  expiredInitial.prior_lease_receipts = structuredClone(
    executionFixture.subject.document.initial.prior_lease_receipts,
  );
  const expiredLease = expiredInitial.prior_lease_receipts[0];
  Object.assign(expiredWork, {work_version: 4});
  Object.assign(expiredWork.cancellation_receipt, {work_version: 4, journal_sequence: 4,
    cancellation_tick: expiredLease.expires_tick});
  Object.assign(expiredWork.cancellation_receipt.vault_owner_receipt, {
    work_version: 3, lease_id: expiredLease.lease_id,
  });
  Object.assign(expiredWork.cancellation_receipt.vault_owner_receipt, signControlPlaneReceipt(
    'vault_owner_authorization', vaultOwnerFields(expiredWork.cancellation_receipt.vault_owner_receipt),
  ));
  Object.assign(expiredWork.cancellation_receipt, signControlPlaneReceipt(
    'work_journal_cancellation', journalCancellationFields(expiredWork.cancellation_receipt),
  ));
  expiredWork.cancellation_history = [structuredClone(expiredWork.cancellation_receipt)];
  Object.assign(expiredWork.completion_receipt, {
    work_version: 4, journal_sequence: 5, lease_id: expiredLease.lease_id,
  });
  Object.assign(expiredWork.completion_receipt, signControlPlaneReceipt(
    'work_completion', completionFields(expiredWork.completion_receipt),
  ));
  expiredWork.completion_history = [structuredClone(expiredWork.completion_receipt)];
  expiredInitial.journal_head_sequence = 5;
  authenticateScenarioHead(expiredInitial);
  Object.assign(expiredPersistedCancellation.document.action, {
    expected_work_version: 4, expected_journal_head_sequence: 5,
    expected_journal_head_digest: expiredInitial.journal_head_digest,
  });
  authenticateVaultOwnerAction(expiredPersistedCancellation);
  assert.deepEqual((await observeControlPlaneScenario(expiredPersistedCancellation, packageRoot)).codes,
    ['control.lease_history_invalid']);

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
  authenticateScenarioHead(forgedCancellation.document.initial);
  assert.deepEqual((await observeControlPlaneScenario(forgedCancellation, packageRoot)).codes,
    ['control.lease_history_invalid']);

  const forgedRestart = structuredClone(cancelledFixture.subject);
  forgedRestart.document.initial.work.cancellation_receipt.signature_digest = '0'.repeat(64);
  forgedRestart.document.initial.work.cancellation_history.at(-1).signature_digest = '0'.repeat(64);
  authenticateScenarioHead(forgedRestart.document.initial);
  assert.deepEqual((await observeControlPlaneScenario(forgedRestart, packageRoot)).codes,
    ['control.lease_history_invalid']);

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

  const leasedResume = JSON.parse(await readFile(new URL('./scenarios/control-plane/authorized-bounded-resume-recorded.json', import.meta.url)));
  leasedResume.subject.document.action.lease_id = 'lease:stale-999';
  authenticateVaultOwnerAction(leasedResume.subject);
  assert.deepEqual((await observeControlPlaneScenario(leasedResume.subject, packageRoot)).codes,
    ['schema.constraint']);

  const reverseOrder = JSON.parse(await readFile(new URL('./scenarios/control-plane/authorized-bounded-resume-recorded.json', import.meta.url)));
  const reverseWork = reverseOrder.subject.document.initial.work;
  reverseWork.cancellation_receipt.journal_sequence = 3;
  Object.assign(reverseWork.cancellation_receipt, signControlPlaneReceipt(
    'work_journal_cancellation', journalCancellationFields(reverseWork.cancellation_receipt),
  ));
  reverseWork.cancellation_history = [structuredClone(reverseWork.cancellation_receipt)];
  reverseWork.completion_receipt.journal_sequence = 2;
  Object.assign(reverseWork.completion_receipt, signControlPlaneReceipt(
    'work_completion', completionFields(reverseWork.completion_receipt),
  ));
  reverseWork.completion_history = [structuredClone(reverseWork.completion_receipt)];
  authenticateScenarioHead(reverseOrder.subject.document.initial);
  assert.deepEqual((await observeControlPlaneScenario(reverseOrder.subject, packageRoot)).codes,
    ['control.lease_history_invalid']);

  const staleLease = JSON.parse(await readFile(new URL('./scenarios/control-plane/cancellation-during-execution-durable.json', import.meta.url)));
  staleLease.subject.document.action.lease_id = 'lease:stale-999';
  authenticateVaultOwnerAction(staleLease.subject);
  assert.deepEqual((await observeControlPlaneScenario(staleLease.subject, packageRoot)).codes,
    ['control.lease_stale']);

  const expiredCancellation = JSON.parse(await readFile(new URL('./scenarios/control-plane/cancellation-during-execution-durable.json', import.meta.url)));
  expiredCancellation.subject.document.initial.work.lease_status = 'expired';
  assert.deepEqual((await observeControlPlaneScenario(expiredCancellation.subject, packageRoot)).codes,
    ['control.lease_history_invalid']);

  const replayFixture = JSON.parse(await readFile(new URL('./scenarios/control-plane/authorized-bounded-resume-recorded.json', import.meta.url)));
  const replayInitial = replayFixture.subject.document.initial;
  const cancelledVersion = replayInitial.work.work_version;
  const cancellationCompletion = replayInitial.work.completion_receipt;
  Object.assign(replayInitial.work, {
    work_version: cancelledVersion + 1, state: 'queued', cancellation_id: null,
    resume_count: 1, completion_receipt: null,
  });
  replayInitial.work.resume_receipt = {
    receipt_id: 'resume-receipt:work-001', work_id: replayInitial.work.work_id,
    cancelled_work_version: cancelledVersion, resumed_work_version: cancelledVersion + 1,
    idempotency_key: replayInitial.work.idempotency_key,
    vault_owner_receipt: structuredClone(replayFixture.subject.document.action.vault_owner_receipt),
    cancellation_receipt_id: replayInitial.work.cancellation_receipt.receipt_id,
    cancellation_receipt_signature_digest: replayInitial.work.cancellation_receipt.signature_digest,
    cancellation_completion_receipt_id: cancellationCompletion.receipt_id,
    cancellation_completion_signature_digest: cancellationCompletion.signature_digest,
    resume_count: 1, journal_sequence: replayInitial.journal_head_sequence + 1,
  };
  Object.assign(replayInitial.work.resume_receipt, signControlPlaneReceipt(
    'work_resume', resumeFields(replayInitial.work.resume_receipt),
  ));
  authenticateScenarioHead(replayInitial);
  replayFixture.subject.document.action.expected_work_version = cancelledVersion;
  const replayResult = await observeControlPlaneScenario(replayFixture.subject, packageRoot);
  assert.equal(replayResult.verdict, 'pass');
  assert.deepEqual(replayResult.filesystem_effects, ['none']);
  assert.equal(replayResult.outputs.includes('resume idempotent'), true);

  const reboundCompletion = structuredClone(replayFixture.subject);
  const reboundWork = reboundCompletion.document.initial.work;
  reboundWork.completion_history[0].receipt_id = 'receipt:cancelled-rebound-001';
  Object.assign(reboundWork.completion_history[0], signControlPlaneReceipt(
    'work_completion', completionFields(reboundWork.completion_history[0]),
  ));
  assert.deepEqual((await observeControlPlaneScenario(reboundCompletion, packageRoot)).codes,
    ['control.lease_history_invalid']);

  const crossVaultResume = structuredClone(replayFixture.subject);
  const crossVaultWork = crossVaultResume.document.initial.work;
  crossVaultWork.resume_receipt.vault_owner_receipt.vault_id = 'vault:other-001';
  Object.assign(crossVaultWork.resume_receipt.vault_owner_receipt, signControlPlaneReceipt(
    'vault_owner_authorization', vaultOwnerFields(crossVaultWork.resume_receipt.vault_owner_receipt),
  ));
  Object.assign(crossVaultWork.resume_receipt, {
    cancellation_receipt_signature_digest: crossVaultWork.cancellation_history[0].signature_digest,
    cancellation_completion_signature_digest: crossVaultWork.completion_history[0].signature_digest,
  });
  Object.assign(crossVaultWork.resume_receipt, signControlPlaneReceipt(
    'work_resume', resumeFields(crossVaultWork.resume_receipt),
  ));
  assert.deepEqual((await observeControlPlaneScenario(crossVaultResume, packageRoot)).codes,
    ['schema.constraint']);

  const phantomLeaseHistory = structuredClone(replayFixture.subject);
  const phantomWork = phantomLeaseHistory.document.initial.work;
  phantomWork.cancellation_receipt.vault_owner_receipt.lease_id = 'lease:phantom-001';
  Object.assign(phantomWork.cancellation_receipt.vault_owner_receipt, signControlPlaneReceipt(
    'vault_owner_authorization', vaultOwnerFields(phantomWork.cancellation_receipt.vault_owner_receipt),
  ));
  Object.assign(phantomWork.cancellation_receipt, signControlPlaneReceipt(
    'work_journal_cancellation', journalCancellationFields(phantomWork.cancellation_receipt),
  ));
  phantomWork.cancellation_history = [structuredClone(phantomWork.cancellation_receipt)];
  phantomWork.completion_history[0].lease_id = 'lease:phantom-001';
  Object.assign(phantomWork.completion_history[0], signControlPlaneReceipt(
    'work_completion', completionFields(phantomWork.completion_history[0]),
  ));
  Object.assign(phantomWork.resume_receipt, {
    cancellation_receipt_signature_digest: phantomWork.cancellation_history[0].signature_digest,
    cancellation_completion_signature_digest: phantomWork.completion_history[0].signature_digest,
  });
  Object.assign(phantomWork.resume_receipt, signControlPlaneReceipt(
    'work_resume', resumeFields(phantomWork.resume_receipt),
  ));
  assert.deepEqual((await observeControlPlaneScenario(phantomLeaseHistory, packageRoot)).codes,
    ['control.lease_history_invalid']);

  const invalidCancellationOutcome = structuredClone(replayFixture.subject);
  const invalidOutcomeWork = invalidCancellationOutcome.document.initial.work;
  Object.assign(invalidOutcomeWork.completion_history[0], {
    code: 'control.execution_failed', failure_retryable: false, failure_observed_tick: 1,
  });
  Object.assign(invalidOutcomeWork.completion_history[0], signControlPlaneReceipt(
    'work_completion', completionFields(invalidOutcomeWork.completion_history[0]),
  ));
  invalidOutcomeWork.resume_receipt.cancellation_completion_signature_digest =
    invalidOutcomeWork.completion_history[0].signature_digest;
  Object.assign(invalidOutcomeWork.resume_receipt, signControlPlaneReceipt(
    'work_resume', resumeFields(invalidOutcomeWork.resume_receipt),
  ));
  assert.deepEqual((await observeControlPlaneScenario(invalidCancellationOutcome, packageRoot)).codes,
    ['control.lease_history_invalid']);

  const nonAdjacentResume = structuredClone(replayFixture.subject);
  nonAdjacentResume.document.initial.work.resume_receipt.journal_sequence += 1;
  Object.assign(nonAdjacentResume.document.initial.work.resume_receipt, signControlPlaneReceipt(
    'work_resume', resumeFields(nonAdjacentResume.document.initial.work.resume_receipt),
  ));
  nonAdjacentResume.document.initial.journal_head_sequence += 1;
  nonAdjacentResume.document.initial.journal_head_receipt.head_sequence += 1;
  Object.assign(nonAdjacentResume.document.initial.journal_head_receipt, signControlPlaneReceipt(
    'work_journal_head', journalHeadFields(nonAdjacentResume.document.initial.journal_head_receipt),
  ));
  assert.deepEqual((await observeControlPlaneScenario(nonAdjacentResume, packageRoot)).codes,
    ['control.lease_history_invalid']);

  const nonQueuedReplay = structuredClone(replayFixture.subject);
  Object.assign(nonQueuedReplay.document.initial.work,
    {state: 'retry_wait', retry_eligible_tick: 1000});
  assert.deepEqual((await observeControlPlaneScenario(nonQueuedReplay, packageRoot)).codes,
    ['control.lease_history_invalid']);

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
    ['control.lease_history_invalid']);

  const readinessFixture = JSON.parse(await readFile(new URL('./scenarios/control-plane/readiness-work-journal-unavailable.json', import.meta.url)));
  readinessFixture.subject.document.initial.agent_state = 'ready';
  const readinessResult = await observeControlPlaneScenario(readinessFixture.subject, packageRoot);
  assert.deepEqual(readinessResult.codes, ['control.illegal_transition']);
  assert.equal(readinessResult.illegal_transition, true);
});

test('cancellation accepts exactly two remaining journal slots and rejects one', async () => {
  const fixture = JSON.parse(await readFile(new URL('./scenarios/control-plane/cancellation-before-dispatch-durable.json', import.meta.url)));
  const boundary = structuredClone(fixture.subject);
  const {action, initial} = boundary.document;
  function installPrefix(headSequence) {
    const prefix = initial.journal_prefix_receipt;
    prefix.head_sequence = headSequence - 1;
    prefix.head_digest = 'a'.repeat(64);
    Object.assign(prefix, signControlPlaneReceipt(
      'work_journal_prefix', journalPrefixFields(prefix),
    ));
    initial.work.enqueue_receipt.base_head_sequence = prefix.head_sequence;
    initial.work.enqueue_receipt.base_head_digest = prefix.head_digest;
    initial.work.enqueue_receipt.journal_sequence = headSequence;
    Object.assign(initial.work.enqueue_receipt, signControlPlaneReceipt(
      'work_enqueue', [
        initial.work.enqueue_receipt.receipt_id, initial.work.enqueue_receipt.work_id,
        initial.work.enqueue_receipt.work_version, initial.work.enqueue_receipt.idempotency_key,
        initial.work.enqueue_receipt.input_digest, initial.work.enqueue_receipt.base_head_sequence,
        initial.work.enqueue_receipt.base_head_digest, initial.work.enqueue_receipt.journal_sequence,
      ],
    ));
    authenticateScenarioHead(initial);
    action.expected_journal_head_sequence = initial.journal_head_sequence;
    action.expected_journal_head_digest = initial.journal_head_digest;
  }
  installPrefix(498);
  const accepted = await observeControlPlaneScenario(boundary, packageRoot);
  assert.equal(accepted.verdict, 'pass');
  assert.equal(accepted.terminal_state, 'cancelled');

  installPrefix(499);
  assert.deepEqual((await observeControlPlaneScenario(boundary, packageRoot)).codes,
    ['control.journal_capacity_exhausted']);
});

test('complete_work records one authenticated success and rejects stale execution bases', async () => {
  const fixture = JSON.parse(await readFile(new URL(
    './scenarios/control-plane/cancellation-during-execution-durable.json', import.meta.url,
  )));
  const {action, initial} = fixture.subject.document;
  Object.assign(action, {
    kind: 'complete_work', actor_role: 'mdplace_agent',
    idempotency_key: initial.work.idempotency_key,
    completion_output_digest: 'e'.repeat(64), current_tick: 2,
    expected_journal_head_sequence: initial.journal_head_sequence,
    expected_journal_head_digest: initial.journal_head_digest,
    vault_owner_receipt: null,
  });
  const completed = await observeControlPlaneScenario(fixture.subject, packageRoot);
  assert.equal(completed.verdict, 'pass');
  assert.equal(completed.terminal_state, 'succeeded');
  assert.equal(completed.outputs.includes('authenticated completion recorded'), true);
  assert.equal(completed.receipts[0].startsWith('CompletionReceipt:'), true);
  assert.deepEqual(completed.filesystem_effects, ['append terminal Work Item result']);

  const mutations = [
    ['control.work_version_stale', (subject) => { subject.document.action.expected_work_version -= 1; }],
    ['control.journal_head_stale', (subject) => { subject.document.action.expected_journal_head_digest = '0'.repeat(64); }],
    ['control.precondition_failed', (subject) => { subject.document.action.lease_id = 'lease:stale-001'; }],
    ['control.precondition_failed', (subject) => { subject.document.action.idempotency_key = 'idempotency:stale-001'; }],
    ['control.precondition_failed', (subject) => { subject.document.action.current_tick = 301; }],
  ];
  for (const [code, mutate] of mutations) {
    const subject = structuredClone(fixture.subject);
    mutate(subject);
    if (subject.document.action.current_tick !== subject.document.initial.scheduler_observed_tick) {
      authenticateScenarioScheduler(subject.document.initial, subject.document.action.current_tick);
      subject.document.action.expected_scheduler_state_digest =
        subject.document.initial.scheduler_state_digest;
    }
    assert.deepEqual((await observeControlPlaneScenario(subject, packageRoot)).codes, [code]);
  }

  const replay = structuredClone(fixture.subject);
  const replayInitial = replay.document.initial;
  const originalLease = replayInitial.work.lease_id;
  const completion = {
    receipt_id: 'receipt:succeeded-001-v4', work_id: replayInitial.work.work_id,
    work_version: 4, lease_id: originalLease,
    idempotency_key: replayInitial.work.idempotency_key,
    base_head_sequence: replayInitial.journal_head_sequence,
    base_head_digest: replayInitial.journal_head_digest,
    journal_sequence: replayInitial.journal_head_sequence + 1, completion_tick: 2,
    outcome: 'succeeded', output_digest: 'e'.repeat(64), code: null,
    failure_retryable: null, failure_observed_tick: null, selected_retry_delay_ticks: null,
  };
  Object.assign(completion, signControlPlaneReceipt(
    'work_completion', completionFields(completion),
  ));
  Object.assign(replayInitial.work, {
    work_version: 4, state: 'succeeded', lease_id: null, lease_status: null,
    lease_acquired_tick: null, lease_expires_tick: null, owner_agent_id: null,
    completion_receipt: completion, completion_history: [completion],
  });
  replayInitial.active_lease_ids = [];
  replayInitial.active_work_count = 0;
  replayInitial.scheduler_active_lease_receipts = [];
  replayInitial.scheduler_state_digest = schedulerStateDigest([]);
  replay.document.action.expected_scheduler_state_digest = replayInitial.scheduler_state_digest;
  authenticateScenarioHead(replayInitial);
  const replayResult = await observeControlPlaneScenario(replay, packageRoot);
  assert.equal(replayResult.verdict, 'pass');
  assert.equal(replayResult.outputs.includes('completion idempotent'), true);
  assert.deepEqual(replayResult.filesystem_effects, ['none']);
});

test('acknowledgement and Scheduler observations reject pre-acquisition and expired leases', async () => {
  const acknowledgement = JSON.parse(await readFile(new URL(
    './scenarios/control-plane/stale-lease-rejected.json', import.meta.url,
  )));
  acknowledgement.subject.document.action.lease_id = acknowledgement.subject.document.initial.work.lease_id;
  acknowledgement.subject.document.action.current_tick = 0;
  authenticateScenarioScheduler(acknowledgement.subject.document.initial, 0);
  acknowledgement.subject.document.action.expected_scheduler_state_digest =
    acknowledgement.subject.document.initial.scheduler_state_digest;
  assert.deepEqual((await observeControlPlaneScenario(acknowledgement.subject, packageRoot)).codes,
    ['control.lease_stale']);

  const dispatchFixture = JSON.parse(await readFile(new URL(
    './scenarios/control-plane/dequeue-acknowledges-after-receipt.json', import.meta.url,
  )));
  const {action, initial} = dispatchFixture.subject.document;
  action.current_tick = 302;
  initial.scheduler_observed_tick = 302;
  initial.active_lease_ids = Array.from({length: 8}, (_, index) => `lease:expired-${index + 1}`);
  initial.active_work_count = 8;
  initial.scheduler_active_lease_receipts = initial.active_lease_ids.map((leaseId, index) => {
    const receipt = {
      receipt_id: `scheduler-lease-receipt:expired-${index + 1}`,
      vault_id: initial.vault_id, lease_id: leaseId, work_id: `work:expired-${index + 1}`,
      work_version: 1, owner_agent_id: initial.persistent_agent_id,
      acquired_tick: 1, expires_tick: 301, status: 'active',
    };
    return {...receipt, ...signControlPlaneReceipt(
      'scheduler_active_lease', schedulerLeaseFields(receipt),
    )};
  });
  initial.scheduler_state_digest = schedulerStateDigest(initial.active_lease_ids);
  action.expected_scheduler_state_digest = initial.scheduler_state_digest;
  assert.deepEqual((await observeControlPlaneScenario(dispatchFixture.subject, packageRoot)).codes,
    ['control.scheduler_base_stale']);

  const cancellation = JSON.parse(await readFile(new URL(
    './scenarios/control-plane/cancellation-during-execution-durable.json', import.meta.url,
  )));
  authenticateScenarioScheduler(cancellation.subject.document.initial, 301);
  assert.deepEqual((await observeControlPlaneScenario(cancellation.subject, packageRoot)).codes,
    ['control.scheduler_base_stale']);

  const recovery = JSON.parse(await readFile(new URL(
    './scenarios/control-plane/in-flight-work-recovers-agent-crash.json', import.meta.url,
  )));
  const recoveryInitial = recovery.subject.document.initial;
  Object.assign(recoveryInitial.journal_prefix_receipt, {
    head_sequence: 1, head_digest: 'f'.repeat(64), active_leases: [{
    lease_id: 'lease:prefix-001', work_id: 'work:prefix-001', work_version: 1,
    owner_agent_id: recoveryInitial.persistent_agent_id,
    acquired_tick: 1, expires_tick: 1000, status: 'active',
  }],
  });
  Object.assign(recoveryInitial.journal_prefix_receipt, signControlPlaneReceipt(
    'work_journal_prefix', journalPrefixFields(recoveryInitial.journal_prefix_receipt),
  ));
  Object.assign(recoveryInitial.work.enqueue_receipt, {
    base_head_sequence: 1, base_head_digest: recoveryInitial.journal_prefix_receipt.head_digest,
    journal_sequence: 2,
  });
  Object.assign(recoveryInitial.work.enqueue_receipt, signControlPlaneReceipt(
    'work_enqueue', [
      recoveryInitial.work.enqueue_receipt.receipt_id,
      recoveryInitial.work.enqueue_receipt.work_id,
      recoveryInitial.work.enqueue_receipt.work_version,
      recoveryInitial.work.enqueue_receipt.idempotency_key,
      recoveryInitial.work.enqueue_receipt.input_digest,
      recoveryInitial.work.enqueue_receipt.base_head_sequence,
      recoveryInitial.work.enqueue_receipt.base_head_digest,
      recoveryInitial.work.enqueue_receipt.journal_sequence,
    ],
  ));
  for (const receipt of recoveryInitial.prior_lease_receipts) {
    receipt.journal_sequence += 1;
    Object.assign(receipt, signControlPlaneReceipt('work_lease', leaseFields(receipt)));
  }
  authenticateScenarioHead(recoveryInitial);
  recovery.subject.document.action.expected_journal_head_sequence = recoveryInitial.journal_head_sequence;
  recovery.subject.document.action.expected_journal_head_digest = recoveryInitial.journal_head_digest;
  authenticateScenarioScheduler(recoveryInitial, 1000);
  assert.deepEqual((await observeControlPlaneScenario(recovery.subject, packageRoot)).codes,
    ['control.scheduler_base_stale']);

  const futureTerminal = JSON.parse(await readFile(new URL(
    './scenarios/control-plane/retry-beyond-ceiling-denied.json', import.meta.url,
  )));
  const futureInitial = futureTerminal.subject.document.initial;
  futureTerminal.subject.document.action.current_tick = 1;
  futureInitial.scheduler_observed_tick = 1;
  futureInitial.active_lease_ids = [];
  futureInitial.active_work_count = 0;
  futureInitial.scheduler_active_lease_receipts = [];
  futureInitial.scheduler_state_digest = schedulerStateDigest([]);
  futureTerminal.subject.document.action.expected_scheduler_state_digest =
    futureInitial.scheduler_state_digest;
  assert.deepEqual((await observeControlPlaneScenario(futureTerminal.subject, packageRoot)).codes,
    ['control.scheduler_base_stale']);
});

test('terminal recover_work remains illegal while restart preserves completion', async () => {
  const fixture = JSON.parse(await readFile(new URL(
    './scenarios/control-plane/completed-work-not-repeated-restart.json', import.meta.url,
  )));
  const {action, initial} = fixture.subject.document;
  const completionTick = initial.work.completion_receipt.completion_tick;
  authenticateScenarioScheduler(initial, completionTick);
  Object.assign(action, {
    kind: 'recover', actor_role: 'mdplace_agent', work_id: initial.work.work_id,
    expected_work_version: initial.work.work_version, lease_id: null,
    recovery_tick: completionTick, expected_scheduler_state_digest: initial.scheduler_state_digest,
  });
  const observed = await observeControlPlaneScenario(fixture.subject, packageRoot);
  assert.deepEqual(observed.codes, ['control.illegal_transition']);
  assert.equal(observed.illegal_transition, true);
  assert.equal(observed.terminal_state, 'succeeded');
});

test('Scheduler schema cannot represent more queue entries than the Work Journal', async () => {
  const scheduler = JSON.parse(await readFile(new URL(
    '../contracts/control-plane/scheduler-state.json', import.meta.url,
  )));
  scheduler.eligible_queue = Array.from({length: 501}, (_, index) => ({
    work_id: `work:queue-${index + 1}`, work_version: 1, priority: 4,
    eligible_tick: 0, input_digest: 'b'.repeat(64),
  }));
  const errors = await validateAgainstSchemaPath(
    packageRoot, 'contracts/schemas/scheduler-state.schema.json', scheduler,
  );
  assert.ok(errors.some(({keyword}) => keyword === 'maxItems'));
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
    journal.head_sequence = 4;
    Object.assign(work, {state: 'failed', work_version: 4});
    work.result = {outcome: 'failed', receipt_id: 'receipt:failed-001', work_version: 4,
      work_id: work.work_id, lease_id: 'lease:001', idempotency_key: work.idempotency_key,
      base_head_sequence: 3, base_head_digest: null,
      journal_sequence: 4, completion_tick: 2, output_digest: null,
      code: 'control.execution_failed', failure_retryable: false, failure_observed_tick: 2,
      selected_retry_delay_ticks: null};
    journal.receipts.push(authenticateJournalRecord({receipt_id: 'receipt:lease-001', receipt_kind: 'lease',
      journal_sequence: 2, work_id: work.work_id, work_version: 2,
      lease_id: work.result.lease_id, state: 'leased', operation_digest: 'b'.repeat(64),
      semantic_state_digest: 'd'.repeat(64), owner_agent_id: 'agent:primary-001',
      acquired_tick: 0, expires_tick: 300, lease_status: 'active'}));
    journal.receipts.push(authenticateJournalRecord({receipt_id: 'receipt:start-001', receipt_kind: 'start',
      journal_sequence: 3, work_id: work.work_id, work_version: 3,
      lease_id: work.result.lease_id, state: 'executing', operation_digest: 'e'.repeat(64),
      semantic_state_digest: 'd'.repeat(64), owner_agent_id: 'agent:primary-001', started_tick: 1}));
    work.result.base_head_digest = workJournalHeadDigest(journal.receipts);
    Object.assign(work.result, signControlPlaneReceipt('work_completion', completionFields(work.result)));
    work.completion_history = [work.result];
    journal.receipts.push(authenticateJournalRecord({receipt_id: work.result.receipt_id, receipt_kind: 'completion',
      journal_sequence: 4, work_id: work.work_id, work_version: work.work_version,
      lease_id: work.result.lease_id,
      state: 'failed', operation_digest: 'a'.repeat(64), semantic_state_digest: 'd'.repeat(64)}));
    journal.head_digest = workJournalHeadDigest(journal.receipts);
    return {temporaryRoot, journalPath, journal, work};
  }

  const valid = await terminalJournal();
  await writeFile(valid.journalPath, `${JSON.stringify(valid.journal, null, 2)}\n`);
  const validReport = await buildValidationReport(valid.temporaryRoot);
  assert.equal(validReport.checks.find(({id}) => id === 'control-plane-contract').codes
    .includes('control.work_journal_state_invalid'), false);

  const futureScheduler = await terminalJournal();
  await writeControlPlaneState(futureScheduler.temporaryRoot, futureScheduler.journal);
  const futureSchedulerPath = `${futureScheduler.temporaryRoot}/contracts/control-plane/scheduler-state.json`;
  const futureSchedulerState = JSON.parse(await readFile(futureSchedulerPath));
  futureSchedulerState.observation_tick = 1;
  futureSchedulerState.active_leases = [];
  await writeFile(futureSchedulerPath, `${JSON.stringify(futureSchedulerState, null, 2)}\n`);
  const futureSchedulerReport = await buildValidationReport(futureScheduler.temporaryRoot);
  assert.ok(futureSchedulerReport.checks.find(({id}) => id === 'control-plane-contract').codes
    .includes('control.scheduler_state_invalid'));

  const failureBeforeStart = await terminalJournal();
  failureBeforeStart.journal.receipts[2].started_tick = 10;
  authenticateJournalRecord(failureBeforeStart.journal.receipts[2]);
  Object.assign(failureBeforeStart.work.result, {
    completion_tick: 11, failure_observed_tick: 5,
    base_head_digest: workJournalHeadDigest(failureBeforeStart.journal.receipts.slice(0, 3)),
  });
  Object.assign(failureBeforeStart.work.result, signControlPlaneReceipt(
    'work_completion', completionFields(failureBeforeStart.work.result),
  ));
  failureBeforeStart.work.completion_history = [failureBeforeStart.work.result];
  await writeControlPlaneState(failureBeforeStart.temporaryRoot, failureBeforeStart.journal);
  const failureBeforeStartReport = await buildValidationReport(failureBeforeStart.temporaryRoot);
  assert.ok(failureBeforeStartReport.checks.find(({id}) => id === 'control-plane-contract').codes
    .includes('control.work_journal_state_invalid'));

  const phantomTerminal = await terminalJournal();
  Object.assign(phantomTerminal.work, {state: 'queued', result: null});
  await writeFile(phantomTerminal.journalPath, `${JSON.stringify(phantomTerminal.journal, null, 2)}\n`);
  const phantomTerminalReport = await buildValidationReport(phantomTerminal.temporaryRoot);
  assert.ok(phantomTerminalReport.checks.find(({id}) => id === 'control-plane-contract').codes
    .includes('control.work_journal_state_invalid'));

  const validOverflow = await terminalJournal();
  Object.assign(validOverflow.journal.receipts[1], {acquired_tick: 998900, expires_tick: 999200});
  authenticateJournalRecord(validOverflow.journal.receipts[1]);
  validOverflow.journal.receipts[2].started_tick = 998901;
  authenticateJournalRecord(validOverflow.journal.receipts[2]);
  validOverflow.journal.head_digest = workJournalHeadDigest(validOverflow.journal.receipts);
  Object.assign(validOverflow.work.result, {code: 'control.retry_tick_overflow',
    base_head_digest: workJournalHeadDigest(validOverflow.journal.receipts.slice(0, 3)),
    completion_tick: 999000, failure_retryable: true, failure_observed_tick: 999000,
    selected_retry_delay_ticks: 1000});
  Object.assign(validOverflow.work.result, signControlPlaneReceipt(
    'work_completion', completionFields(validOverflow.work.result),
  ));
  validOverflow.work.completion_history = [validOverflow.work.result];
  await writeFile(validOverflow.journalPath, `${JSON.stringify(validOverflow.journal, null, 2)}\n`);
  const validOverflowReport = await buildValidationReport(validOverflow.temporaryRoot);
  assert.equal(validOverflowReport.checks.find(({id}) => id === 'control-plane-contract').codes
    .includes('control.work_journal_state_invalid'), false);

  validOverflow.work.result.failure_observed_tick = 999200;
  Object.assign(validOverflow.work.result, signControlPlaneReceipt(
    'work_completion', completionFields(validOverflow.work.result),
  ));
  validOverflow.work.completion_history = [validOverflow.work.result];
  await writeFile(validOverflow.journalPath, `${JSON.stringify(validOverflow.journal, null, 2)}\n`);
  const impossibleOverflowReport = await buildValidationReport(validOverflow.temporaryRoot);
  assert.ok(impossibleOverflowReport.checks.find(({id}) => id === 'control-plane-contract').codes
    .includes('control.work_journal_state_invalid'));

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
  cancelled.journal.head_sequence = 5;
  Object.assign(cancelled.work, {state: 'cancelled', work_version: 4});
  const cancellationAuthorization = {
    receipt_id: 'vault-owner-receipt:cancel-001-v1', principal_id: 'person:owner-001',
    vault_id: cancelled.journal.vault_id, action_kind: 'cancel', work_id: cancelled.work.work_id,
    work_version: 3, lease_id: 'lease:001', idempotency_key: cancelled.work.idempotency_key,
  };
  Object.assign(cancellationAuthorization, signControlPlaneReceipt(
    'vault_owner_authorization', vaultOwnerFields(cancellationAuthorization),
  ));
  cancelled.work.cancellation = {
    receipt_id: 'cancellation-receipt:001', cancellation_id: 'cancel:001',
    work_id: cancelled.work.work_id, work_version: cancelled.work.work_version,
    idempotency_key: cancelled.work.idempotency_key, requested_by: 'person:owner-001',
    vault_owner_receipt: cancellationAuthorization,
    journal_sequence: 4, cancellation_tick: 1, reason_code: 'user_requested',
    resume_count: 0, resume_ceiling: 1,
  };
  Object.assign(cancelled.work.cancellation, signControlPlaneReceipt(
    'work_journal_cancellation', journalCancellationFields(cancelled.work.cancellation),
  ));
  Object.assign(cancelled.work.result, {outcome: 'cancelled', receipt_id: 'receipt:cancelled-001',
    work_version: 4, idempotency_key: cancelled.work.idempotency_key,
    base_head_sequence: 3, base_head_digest: workJournalHeadDigest(cancelled.journal.receipts.slice(0, 3)),
    journal_sequence: 5, completion_tick: 1, output_digest: null, code: 'control.cancelled',
    failure_retryable: null, failure_observed_tick: null, selected_retry_delay_ticks: null});
  Object.assign(cancelled.work.result, signControlPlaneReceipt('work_completion', completionFields(cancelled.work.result)));
  cancelled.journal.receipts.pop();
  cancelled.journal.receipts.push(authenticateJournalRecord({
    receipt_id: cancelled.work.cancellation.receipt_id, receipt_kind: 'cancellation',
    journal_sequence: 4, work_id: cancelled.work.work_id,
    work_version: cancelled.work.work_version, lease_id: cancelled.work.result.lease_id,
    state: 'cancelled', operation_digest: 'c'.repeat(64), semantic_state_digest: 'd'.repeat(64),
  }), authenticateJournalRecord({receipt_id: cancelled.work.result.receipt_id, receipt_kind: 'completion',
    journal_sequence: 5, work_id: cancelled.work.work_id, work_version: cancelled.work.work_version,
    lease_id: cancelled.work.result.lease_id, state: 'cancelled', operation_digest: 'a'.repeat(64),
    semantic_state_digest: 'd'.repeat(64)}));
  Object.assign(cancelled.work.result, {
    base_head_sequence: 4,
    base_head_digest: workJournalHeadDigest(cancelled.journal.receipts.slice(0, 4)),
  });
  Object.assign(cancelled.work.result, signControlPlaneReceipt(
    'work_completion', completionFields(cancelled.work.result),
  ));
  cancelled.work.cancellation_history = [cancelled.work.cancellation];
  cancelled.work.completion_history = [cancelled.work.result];
  cancelled.journal.head_digest = workJournalHeadDigest(cancelled.journal.receipts);
  await writeFile(cancelled.journalPath, `${JSON.stringify(cancelled.journal, null, 2)}\n`);
  const cancelledReport = await buildValidationReport(cancelled.temporaryRoot);
  assert.equal(cancelledReport.checks.find(({id}) => id === 'control-plane-contract').codes
    .includes('control.work_journal_state_invalid'), false);

  cancelled.work.cancellation.journal_sequence = 5;
  Object.assign(cancelled.work.cancellation, signControlPlaneReceipt(
    'work_journal_cancellation', journalCancellationFields(cancelled.work.cancellation),
  ));
  cancelled.work.result.journal_sequence = 4;
  Object.assign(cancelled.work.result, signControlPlaneReceipt('work_completion', completionFields(cancelled.work.result)));
  Object.assign(cancelled.journal.receipts.at(-2), {journal_sequence: 5});
  authenticateJournalRecord(cancelled.journal.receipts.at(-2));
  Object.assign(cancelled.journal.receipts.at(-1), {journal_sequence: 4});
  authenticateJournalRecord(cancelled.journal.receipts.at(-1));
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

test('Work Journal derives exact lease and recovery state from authenticated lifecycle receipts', async () => {
  async function executingJournal() {
    const temporaryRoot = await copyCommittedPackage();
    const journal = JSON.parse(await readFile(
      `${temporaryRoot}/contracts/control-plane/work-journal.json`,
    ));
    const work = journal.work_items[0];
    const lease = {
      receipt_id: 'receipt:lease-001', receipt_kind: 'lease', journal_sequence: 2,
      work_id: work.work_id, work_version: 2, lease_id: 'lease:001', state: 'leased',
      operation_digest: '1'.repeat(64), semantic_state_digest: work.dependencies[0].digest,
      owner_agent_id: 'agent:primary-001', acquired_tick: 0, expires_tick: 300,
      lease_status: 'active',
    };
    const start = {
      receipt_id: 'receipt:start-001', receipt_kind: 'start', journal_sequence: 3,
      work_id: work.work_id, work_version: 3, lease_id: lease.lease_id, state: 'executing',
      operation_digest: '2'.repeat(64), semantic_state_digest: work.dependencies[0].digest,
      owner_agent_id: 'agent:primary-001', started_tick: 1,
    };
    journal.receipts.push(authenticateJournalRecord(lease), authenticateJournalRecord(start));
    Object.assign(work, {
      work_version: 3,
      state: 'executing',
      lease: {
        lease_id: lease.lease_id, work_id: work.work_id, work_version: 3,
        owner_agent_id: lease.owner_agent_id, acquired_tick: lease.acquired_tick,
        expires_tick: lease.expires_tick, status: 'active',
      },
    });
    return {temporaryRoot, journal, work};
  }

  const current = await executingJournal();
  await writeControlPlaneState(current.temporaryRoot, current.journal);
  const currentReport = await buildValidationReport(current.temporaryRoot);
  assert.equal(currentReport.checks.find(({id}) => id === 'control-plane-contract').codes
    .includes('control.work_journal_state_invalid'), false);
  assert.equal(currentReport.checks.find(({id}) => id === 'control-plane-contract').codes
    .includes('control.scheduler_state_invalid'), false);

  current.work.lease.acquired_tick = 1;
  current.work.lease.expires_tick = 301;
  await writeControlPlaneState(current.temporaryRoot, current.journal);
  const relabelledLeaseReport = await buildValidationReport(current.temporaryRoot);
  assert.ok(relabelledLeaseReport.checks.find(({id}) => id === 'control-plane-contract').codes
    .includes('control.work_journal_state_invalid'));

  const lateStart = await executingJournal();
  lateStart.journal.receipts[2].started_tick = 300;
  authenticateJournalRecord(lateStart.journal.receipts[2]);
  await writeControlPlaneState(lateStart.temporaryRoot, lateStart.journal);
  const lateStartReport = await buildValidationReport(lateStart.temporaryRoot);
  assert.ok(lateStartReport.checks.find(({id}) => id === 'control-plane-contract').codes
    .includes('control.work_journal_state_invalid'));

  const executingRecovery = await executingJournal();
  const recovery = authenticateJournalRecord({
    receipt_id: 'receipt:recovery-001', receipt_kind: 'recovery', journal_sequence: 4,
    work_id: executingRecovery.work.work_id, work_version: 4, lease_id: 'lease:001',
    state: 'retry_wait', operation_digest: '3'.repeat(64),
    semantic_state_digest: executingRecovery.work.dependencies[0].digest,
    recovery_interruption_count: 1, resulting_retry_count: 1, recovery_tick: 300,
    recovery_lease_status: 'expired', recovery_decision: 'requeue',
    selected_retry_delay_ticks: 1000, retry_eligible_tick: 1300,
  });
  executingRecovery.journal.receipts.push(recovery);
  Object.assign(executingRecovery.work, {
    work_version: 4, state: 'retry_wait', retry_count: 1, retry_eligible_tick: 1300,
    recovery_interruption_count: 1, lease: null,
  });
  await writeControlPlaneState(executingRecovery.temporaryRoot, executingRecovery.journal);
  const recoveryReport = await buildValidationReport(executingRecovery.temporaryRoot);
  assert.equal(recoveryReport.checks.find(({id}) => id === 'control-plane-contract').codes
    .includes('control.work_journal_state_invalid'), false);

  const reversedAttemptRoot = await copyCommittedPackage();
  const reversedAttemptPath = `${reversedAttemptRoot}/contracts/control-plane/work-journal.json`;
  const reversedAttemptJournal = JSON.parse(await readFile(reversedAttemptPath));
  const reversedAttemptWork = reversedAttemptJournal.work_items[0];
  reversedAttemptJournal.receipts.push(
    authenticateJournalRecord({
      receipt_id: 'receipt:lease-before-recovery-001', receipt_kind: 'lease', journal_sequence: 2,
      work_id: reversedAttemptWork.work_id, work_version: 2, lease_id: 'lease:before-recovery-001',
      state: 'leased', operation_digest: '4'.repeat(64),
      semantic_state_digest: reversedAttemptWork.dependencies[0].digest,
      owner_agent_id: 'agent:primary-001', acquired_tick: 100, expires_tick: 400,
      lease_status: 'active',
    }),
    authenticateJournalRecord({
      receipt_id: 'receipt:recovery-before-reversal-001', receipt_kind: 'recovery', journal_sequence: 3,
      work_id: reversedAttemptWork.work_id, work_version: 3, lease_id: 'lease:before-recovery-001',
      state: 'queued', operation_digest: '5'.repeat(64),
      semantic_state_digest: reversedAttemptWork.dependencies[0].digest,
      recovery_interruption_count: 1, resulting_retry_count: 0, recovery_tick: 400,
      recovery_lease_status: 'expired', recovery_decision: 'requeue',
      selected_retry_delay_ticks: null, retry_eligible_tick: null,
    }),
    authenticateJournalRecord({
      receipt_id: 'receipt:lease-after-recovery-001', receipt_kind: 'lease', journal_sequence: 4,
      work_id: reversedAttemptWork.work_id, work_version: 4, lease_id: 'lease:after-recovery-001',
      state: 'leased', operation_digest: '6'.repeat(64),
      semantic_state_digest: reversedAttemptWork.dependencies[0].digest,
      owner_agent_id: 'agent:primary-001', acquired_tick: 0, expires_tick: 300,
      lease_status: 'active',
    }),
  );
  Object.assign(reversedAttemptWork, {
    work_version: 4, state: 'leased', recovery_interruption_count: 1,
    lease: {
      lease_id: 'lease:after-recovery-001', work_id: reversedAttemptWork.work_id,
      work_version: 4, owner_agent_id: 'agent:primary-001', acquired_tick: 0,
      expires_tick: 300, status: 'active',
    },
  });
  await writeControlPlaneState(reversedAttemptRoot, reversedAttemptJournal);
  const reversedSchedulerPath = `${reversedAttemptRoot}/contracts/control-plane/scheduler-state.json`;
  const reversedScheduler = JSON.parse(await readFile(reversedSchedulerPath));
  reversedScheduler.active_leases = [];
  await writeFile(reversedSchedulerPath, `${JSON.stringify(reversedScheduler, null, 2)}\n`);
  const reversedAttemptReport = await buildValidationReport(reversedAttemptRoot);
  assert.ok(reversedAttemptReport.checks.find(({id}) => id === 'control-plane-contract').codes
    .includes('control.work_journal_state_invalid'));

  const retrying = await executingJournal();
  retrying.journal.receipts.push(authenticateJournalRecord({
    receipt_id: 'receipt:retry-bound-001', receipt_kind: 'retry', journal_sequence: 4,
    work_id: retrying.work.work_id, work_version: 4, lease_id: 'lease:001',
    state: 'retry_wait', operation_digest: '9'.repeat(64),
    semantic_state_digest: retrying.work.dependencies[0].digest,
    retry_count: 1, failure_retryable: true, failure_observed_tick: 2,
    selected_retry_delay_ticks: 1000, retry_eligible_tick: 1002,
  }));
  Object.assign(retrying.work, {
    work_version: 4, state: 'retry_wait', retry_count: 1,
    retry_eligible_tick: 1002, lease: null,
  });
  await writeControlPlaneState(retrying.temporaryRoot, retrying.journal);
  const retryingReport = await buildValidationReport(retrying.temporaryRoot);
  assert.equal(retryingReport.checks.find(({id}) => id === 'control-plane-contract').codes
    .includes('control.work_journal_state_invalid'), false);

  retrying.journal.receipts.at(-1).lease_id = 'lease:other-001';
  authenticateJournalRecord(retrying.journal.receipts.at(-1));
  await writeControlPlaneState(retrying.temporaryRoot, retrying.journal);
  const wrongRetryLeaseReport = await buildValidationReport(retrying.temporaryRoot);
  assert.ok(wrongRetryLeaseReport.checks.find(({id}) => id === 'control-plane-contract').codes
    .includes('control.work_journal_state_invalid'));

  retrying.journal.receipts.at(-1).lease_id = null;
  authenticateJournalRecord(retrying.journal.receipts.at(-1));
  await writeControlPlaneState(retrying.temporaryRoot, retrying.journal);
  const missingRetryLeaseReport = await buildValidationReport(retrying.temporaryRoot);
  assert.ok(missingRetryLeaseReport.checks.find(({id}) => id === 'schema-instances').codes
    .includes('schema.constraint'));

  const validExecutingRecovery = structuredClone(executingRecovery.journal);
  const recoveryWork = executingRecovery.journal.work_items[0];
  const recoveryRow = executingRecovery.journal.receipts.at(-1);
  recoveryWork.retry_count = 2;
  recoveryRow.resulting_retry_count = 2;
  authenticateJournalRecord(recoveryRow);
  await writeControlPlaneState(executingRecovery.temporaryRoot, executingRecovery.journal);
  const skippedRetryReport = await buildValidationReport(executingRecovery.temporaryRoot);
  assert.ok(skippedRetryReport.checks.find(({id}) => id === 'control-plane-contract').codes
    .includes('control.work_journal_state_invalid'));

  executingRecovery.journal = structuredClone(validExecutingRecovery);
  executingRecovery.work = executingRecovery.journal.work_items[0];
  executingRecovery.journal.receipts.at(-1).retry_eligible_tick = 0;
  executingRecovery.work.retry_eligible_tick = 0;
  authenticateJournalRecord(executingRecovery.journal.receipts.at(-1));
  await writeControlPlaneState(executingRecovery.temporaryRoot, executingRecovery.journal);
  const arbitraryTickReport = await buildValidationReport(executingRecovery.temporaryRoot);
  assert.ok(arbitraryTickReport.checks.find(({id}) => id === 'control-plane-contract').codes
    .includes('control.work_journal_state_invalid'));

  const revokedRecovery = structuredClone(validExecutingRecovery);
  const revokedWork = revokedRecovery.work_items[0];
  const revokedRow = revokedRecovery.receipts.at(-1);
  Object.assign(revokedRow, {
    recovery_tick: 100, recovery_lease_status: 'revoked', retry_eligible_tick: 1100,
  });
  revokedWork.retry_eligible_tick = 1100;
  authenticateJournalRecord(revokedRow);
  await writeControlPlaneState(executingRecovery.temporaryRoot, revokedRecovery);
  const revokedReport = await buildValidationReport(executingRecovery.temporaryRoot);
  assert.ok(revokedReport.checks.find(({id}) => id === 'control-plane-contract').codes
    .includes('control.work_journal_state_invalid'));

  const prematureFailureRoot = await copyCommittedPackage();
  const prematureJournal = JSON.parse(await readFile(
    `${prematureFailureRoot}/contracts/control-plane/work-journal.json`,
  ));
  const prematureWork = prematureJournal.work_items[0];
  const prematureCompletion = {
    receipt_id: 'receipt:failed-premature-001', work_id: prematureWork.work_id,
    work_version: 3, lease_id: 'lease:premature-001', idempotency_key: prematureWork.idempotency_key,
    base_head_sequence: 2, base_head_digest: workJournalHeadDigest(prematureJournal.receipts),
    journal_sequence: 4, completion_tick: 300,
    outcome: 'failed', output_digest: null, code: 'control.execution_failed',
    failure_retryable: false, failure_observed_tick: 300, selected_retry_delay_ticks: null,
  };
  Object.assign(prematureCompletion, signControlPlaneReceipt(
    'work_completion', completionFields(prematureCompletion),
  ));
  prematureJournal.receipts.push(authenticateJournalRecord({
    receipt_id: 'receipt:lease-premature-001', receipt_kind: 'lease', journal_sequence: 2,
    work_id: prematureWork.work_id, work_version: 2, lease_id: 'lease:premature-001',
    state: 'leased', operation_digest: '8'.repeat(64),
    semantic_state_digest: prematureWork.dependencies[0].digest,
    owner_agent_id: 'agent:primary-001', acquired_tick: 0, expires_tick: 300,
    lease_status: 'active',
  }), authenticateJournalRecord({
    receipt_id: 'receipt:recovery-premature-001', receipt_kind: 'recovery', journal_sequence: 3,
    work_id: prematureWork.work_id, work_version: 3, lease_id: 'lease:premature-001',
    state: 'failed', operation_digest: '9'.repeat(64),
    semantic_state_digest: prematureWork.dependencies[0].digest,
    recovery_interruption_count: 1, resulting_retry_count: 0, recovery_tick: 300,
    recovery_lease_status: 'expired', recovery_decision: 'fail',
  }), authenticateJournalRecord({
    receipt_id: prematureCompletion.receipt_id, receipt_kind: 'completion', journal_sequence: 4,
    work_id: prematureWork.work_id, work_version: 3, lease_id: 'lease:premature-001',
    state: 'failed', operation_digest: 'a'.repeat(64),
    semantic_state_digest: prematureWork.dependencies[0].digest,
  }));
  Object.assign(prematureWork, {
    work_version: 3, state: 'failed', recovery_interruption_count: 1,
    lease: null, result: prematureCompletion, completion_history: [prematureCompletion],
  });
  await writeControlPlaneState(prematureFailureRoot, prematureJournal);
  const prematureReport = await buildValidationReport(prematureFailureRoot);
  assert.ok(prematureReport.checks.find(({id}) => id === 'control-plane-contract').codes
    .includes('control.work_journal_state_invalid'));

  const overflowRecovery = await executingJournal();
  const overflowCompletion = {
    receipt_id: 'receipt:failed-overflow-001', work_id: overflowRecovery.work.work_id,
    work_version: 4, lease_id: 'lease:001', idempotency_key: overflowRecovery.work.idempotency_key,
    base_head_sequence: 3, base_head_digest: workJournalHeadDigest(overflowRecovery.journal.receipts),
    journal_sequence: 5, completion_tick: 999000,
    outcome: 'failed', output_digest: null, code: 'control.retry_tick_overflow',
    failure_retryable: true, failure_observed_tick: 999000, selected_retry_delay_ticks: 1000,
  };
  Object.assign(overflowCompletion, signControlPlaneReceipt(
    'work_completion', completionFields(overflowCompletion),
  ));
  overflowRecovery.journal.receipts.push(authenticateJournalRecord({
    receipt_id: 'receipt:recovery-overflow-001', receipt_kind: 'recovery', journal_sequence: 4,
    work_id: overflowRecovery.work.work_id, work_version: 4, lease_id: 'lease:001',
    state: 'failed', operation_digest: 'b'.repeat(64),
    semantic_state_digest: overflowRecovery.work.dependencies[0].digest,
    recovery_interruption_count: 1, resulting_retry_count: 0, recovery_tick: 999000,
    recovery_lease_status: 'expired', recovery_decision: 'fail',
    selected_retry_delay_ticks: 1000,
  }), authenticateJournalRecord({
    receipt_id: overflowCompletion.receipt_id, receipt_kind: 'completion', journal_sequence: 5,
    work_id: overflowRecovery.work.work_id, work_version: 4, lease_id: 'lease:001',
    state: 'failed', operation_digest: 'c'.repeat(64),
    semantic_state_digest: overflowRecovery.work.dependencies[0].digest,
  }));
  Object.assign(overflowCompletion, {
    base_head_sequence: 4,
    base_head_digest: workJournalHeadDigest(overflowRecovery.journal.receipts.slice(0, 4)),
  });
  Object.assign(overflowCompletion, signControlPlaneReceipt(
    'work_completion', completionFields(overflowCompletion),
  ));
  Object.assign(overflowRecovery.work, {
    work_version: 4, state: 'failed', recovery_interruption_count: 1,
    lease: null, result: overflowCompletion, completion_history: [overflowCompletion],
  });
  await writeControlPlaneState(overflowRecovery.temporaryRoot, overflowRecovery.journal);
  const overflowReport = await buildValidationReport(overflowRecovery.temporaryRoot);
  assert.equal(overflowReport.checks.find(({id}) => id === 'control-plane-contract').codes
    .includes('control.work_journal_state_invalid'), false);

  const terminalRoot = await copyCommittedPackage();
  const terminalJournal = JSON.parse(await readFile(
    `${terminalRoot}/contracts/control-plane/work-journal.json`,
  ));
  const terminalWork = terminalJournal.work_items[0];
  for (let index = 0; index < 3; index += 1) {
    const leaseNumber = index + 1;
    const leaseSequence = 2 + index * 2;
    const recoverySequence = leaseSequence + 1;
    terminalJournal.receipts.push(authenticateJournalRecord({
      receipt_id: `receipt:lease-${leaseNumber.toString().padStart(3, '0')}`,
      receipt_kind: 'lease', journal_sequence: leaseSequence,
      work_id: terminalWork.work_id, work_version: leaseSequence,
      lease_id: `lease:${leaseNumber.toString().padStart(3, '0')}`, state: 'leased',
      operation_digest: String(leaseNumber).repeat(64),
      semantic_state_digest: terminalWork.dependencies[0].digest,
      owner_agent_id: 'agent:primary-001', acquired_tick: index * 100,
      expires_tick: (index + 1) * 100, lease_status: 'active',
    }), authenticateJournalRecord({
      receipt_id: `receipt:recovery-${leaseNumber.toString().padStart(3, '0')}`,
      receipt_kind: 'recovery', journal_sequence: recoverySequence,
      work_id: terminalWork.work_id, work_version: recoverySequence,
      lease_id: `lease:${leaseNumber.toString().padStart(3, '0')}`,
      state: index === 2 ? 'failed' : 'queued',
      operation_digest: String(leaseNumber + 3).repeat(64),
      semantic_state_digest: terminalWork.dependencies[0].digest,
      recovery_interruption_count: leaseNumber, resulting_retry_count: 0,
      recovery_tick: (index + 1) * 100, recovery_lease_status: 'expired',
      recovery_decision: index === 2 ? 'fail' : 'requeue',
    }));
  }
  const terminalCompletion = {
    receipt_id: 'receipt:failed-recovery-001', work_id: terminalWork.work_id,
    work_version: 7, lease_id: 'lease:003', idempotency_key: terminalWork.idempotency_key,
    base_head_sequence: 7,
    base_head_digest: workJournalHeadDigest(terminalJournal.receipts.slice(0, 7)),
    journal_sequence: 8, completion_tick: 300,
    outcome: 'failed', output_digest: null, code: 'control.recovery_ceiling_exceeded',
    failure_retryable: null, failure_observed_tick: null, selected_retry_delay_ticks: null,
  };
  Object.assign(terminalCompletion, signControlPlaneReceipt(
    'work_completion', completionFields(terminalCompletion),
  ));
  terminalJournal.receipts.push(authenticateJournalRecord({
    receipt_id: terminalCompletion.receipt_id, receipt_kind: 'completion', journal_sequence: 8,
    work_id: terminalWork.work_id, work_version: 7, lease_id: 'lease:003', state: 'failed',
    operation_digest: '7'.repeat(64), semantic_state_digest: terminalWork.dependencies[0].digest,
  }));
  Object.assign(terminalWork, {
    work_version: 7, state: 'failed', recovery_interruption_count: 3,
    lease: null, result: terminalCompletion, completion_history: [terminalCompletion],
  });
  await writeControlPlaneState(terminalRoot, terminalJournal);
  const terminalReport = await buildValidationReport(terminalRoot);
  assert.equal(terminalReport.checks.find(({id}) => id === 'control-plane-contract').codes
    .includes('control.work_journal_state_invalid'), false);
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
    journal_sequence: 2, cancellation_tick: 1, reason_code: 'user_requested',
    resume_count: 0, resume_ceiling: 1,
  };
  Object.assign(work.cancellation, signControlPlaneReceipt(
    'work_journal_cancellation', journalCancellationFields(work.cancellation),
  ));
  work.cancellation_history = [work.cancellation];
  const cancellationCompletion = {
    receipt_id: 'receipt:cancelled-001', work_id: work.work_id, work_version: 2,
    lease_id: null, idempotency_key: work.idempotency_key,
    base_head_sequence: 1, base_head_digest: workJournalHeadDigest(journal.receipts),
    journal_sequence: 3, completion_tick: 1, outcome: 'cancelled', output_digest: null,
    code: 'control.cancelled', failure_retryable: null, failure_observed_tick: null,
    selected_retry_delay_ticks: null,
  };
  Object.assign(cancellationCompletion, signControlPlaneReceipt(
    'work_completion', completionFields(cancellationCompletion),
  ));
  work.completion_history = [cancellationCompletion];
  const resumeAuthorization = {
    receipt_id: 'vault-owner-receipt:resume-001-v2', principal_id: 'person:owner-001',
    vault_id: journal.vault_id, action_kind: 'resume', work_id: work.work_id,
    work_version: 2, lease_id: null, idempotency_key: work.idempotency_key,
  };
  Object.assign(resumeAuthorization, signControlPlaneReceipt(
    'vault_owner_authorization', vaultOwnerFields(resumeAuthorization),
  ));
  work.resume_receipt = {
    receipt_id: 'resume-receipt:001', work_id: work.work_id,
    cancelled_work_version: 2, resumed_work_version: 3,
    idempotency_key: work.idempotency_key,
    vault_owner_receipt: resumeAuthorization,
    cancellation_receipt_id: work.cancellation.receipt_id,
    cancellation_receipt_signature_digest: work.cancellation.signature_digest,
    cancellation_completion_receipt_id: cancellationCompletion.receipt_id,
    cancellation_completion_signature_digest: cancellationCompletion.signature_digest,
    resume_count: 1, journal_sequence: 4,
  };
  Object.assign(work.resume_receipt, signControlPlaneReceipt(
    'work_resume', resumeFields(work.resume_receipt),
  ));
  journal.receipts.push(authenticateJournalRecord({
    receipt_id: work.cancellation.receipt_id, receipt_kind: 'cancellation',
    journal_sequence: 2, work_id: work.work_id, work_version: 2, lease_id: null,
    state: 'cancelled', operation_digest: 'c'.repeat(64), semantic_state_digest: 'd'.repeat(64),
  }), authenticateJournalRecord({
    receipt_id: cancellationCompletion.receipt_id, receipt_kind: 'completion',
    journal_sequence: 3, work_id: work.work_id, work_version: 2, lease_id: null,
    state: 'cancelled', operation_digest: 'f'.repeat(64), semantic_state_digest: 'd'.repeat(64),
  }), authenticateJournalRecord({
    receipt_id: work.resume_receipt.receipt_id, receipt_kind: 'resume',
    journal_sequence: 4, work_id: work.work_id, work_version: 3, lease_id: null,
    state: 'queued', operation_digest: 'e'.repeat(64), semantic_state_digest: 'd'.repeat(64),
  }));
  Object.assign(cancellationCompletion, {
    base_head_sequence: 2,
    base_head_digest: workJournalHeadDigest(journal.receipts.slice(0, 2)),
  });
  Object.assign(cancellationCompletion, signControlPlaneReceipt(
    'work_completion', completionFields(cancellationCompletion),
  ));
  Object.assign(work.resume_receipt, {
    cancellation_completion_signature_digest: cancellationCompletion.signature_digest,
  });
  Object.assign(work.resume_receipt, signControlPlaneReceipt(
    'work_resume', resumeFields(work.resume_receipt),
  ));
  journal.head_sequence = 4;
  journal.head_digest = workJournalHeadDigest(journal.receipts);
  await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  const validReport = await buildValidationReport(temporaryRoot);
  assert.equal(validReport.checks.find(({id}) => id === 'control-plane-contract').codes
    .includes('control.work_journal_state_invalid'), false);

  const validJournal = structuredClone(journal);

  const recancelRoot = await copyCommittedPackage();
  const recancelPath = `${recancelRoot}/contracts/control-plane/work-journal.json`;
  const recancelJournal = structuredClone(validJournal);
  const recancelWork = recancelJournal.work_items[0];
  const recancelAuthorization = {
    receipt_id: 'vault-owner-receipt:cancel-001-v3', principal_id: 'person:owner-001',
    vault_id: recancelJournal.vault_id, action_kind: 'cancel', work_id: recancelWork.work_id,
    work_version: 3, lease_id: null, idempotency_key: recancelWork.idempotency_key,
  };
  Object.assign(recancelAuthorization, signControlPlaneReceipt(
    'vault_owner_authorization', vaultOwnerFields(recancelAuthorization),
  ));
  const laterCancellation = {
    receipt_id: 'cancellation-receipt:001-v4', cancellation_id: 'cancel:001-v4',
    work_id: recancelWork.work_id, work_version: 4, idempotency_key: recancelWork.idempotency_key,
    requested_by: 'person:owner-001', vault_owner_receipt: recancelAuthorization,
    journal_sequence: 5, cancellation_tick: 1, reason_code: 'user_requested',
    resume_count: 1, resume_ceiling: 1,
  };
  Object.assign(laterCancellation, signControlPlaneReceipt(
    'work_journal_cancellation', journalCancellationFields(laterCancellation),
  ));
  const laterCompletion = {
    receipt_id: 'receipt:cancelled-001-v4', work_id: recancelWork.work_id, work_version: 4,
    lease_id: null, idempotency_key: recancelWork.idempotency_key,
    base_head_sequence: 4, base_head_digest: workJournalHeadDigest(recancelJournal.receipts),
    journal_sequence: 6, completion_tick: 1, outcome: 'cancelled', output_digest: null,
    code: 'control.cancelled', failure_retryable: null, failure_observed_tick: null,
    selected_retry_delay_ticks: null,
  };
  Object.assign(laterCompletion, signControlPlaneReceipt(
    'work_completion', completionFields(laterCompletion),
  ));
  Object.assign(recancelWork, {work_version: 4, state: 'cancelled', cancellation: laterCancellation,
    result: laterCompletion, cancellation_history: [...recancelWork.cancellation_history, laterCancellation],
    completion_history: [...recancelWork.completion_history, laterCompletion]});
  recancelJournal.receipts.push(authenticateJournalRecord({
    receipt_id: laterCancellation.receipt_id, receipt_kind: 'cancellation', journal_sequence: 5,
    work_id: recancelWork.work_id, work_version: 4, lease_id: null, state: 'cancelled',
    operation_digest: '7'.repeat(64), semantic_state_digest: 'd'.repeat(64),
  }), authenticateJournalRecord({
    receipt_id: laterCompletion.receipt_id, receipt_kind: 'completion', journal_sequence: 6,
    work_id: recancelWork.work_id, work_version: 4, lease_id: null, state: 'cancelled',
    operation_digest: '8'.repeat(64), semantic_state_digest: 'd'.repeat(64),
  }));
  Object.assign(laterCompletion, {
    base_head_sequence: 5,
    base_head_digest: workJournalHeadDigest(recancelJournal.receipts.slice(0, 5)),
  });
  Object.assign(laterCompletion, signControlPlaneReceipt(
    'work_completion', completionFields(laterCompletion),
  ));
  recancelJournal.head_sequence = 6;
  recancelJournal.head_digest = workJournalHeadDigest(recancelJournal.receipts);
  await writeFile(recancelPath, `${JSON.stringify(recancelJournal, null, 2)}\n`);
  const recancelReport = await buildValidationReport(recancelRoot);
  assert.equal(recancelReport.checks.find(({id}) => id === 'control-plane-contract').codes
    .includes('control.work_journal_state_invalid'), false);

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

test('Work Journal public boundary represents exactly 500 authenticated receipts', async () => {
  const temporaryRoot = await copyCommittedPackage();
  const journal = JSON.parse(await readFile(
    `${temporaryRoot}/contracts/control-plane/work-journal.json`,
  ));
  const work = journal.work_items[0];
  for (let sequence = 2; sequence <= 500; sequence += 1) {
    journal.receipts.push(authenticateJournalRecord({
      receipt_id: `receipt:rejection-${sequence}`, receipt_kind: 'rejection', journal_sequence: sequence,
      work_id: work.work_id, work_version: work.work_version, lease_id: null, state: 'rejected',
      operation_digest: 'a'.repeat(64), semantic_state_digest: work.dependencies[0].digest,
      rejection_code: 'control.precondition_failed',
    }));
  }
  work.rejection_count = 499;
  await writeControlPlaneState(temporaryRoot, journal);
  const report = await buildValidationReport(temporaryRoot);
  const controlCodes = report.checks.find(({id}) => id === 'control-plane-contract').codes;
  assert.equal(controlCodes.includes('resourceLimit'), false);
  assert.equal(controlCodes.includes('schema.constraint'), false);
  assert.equal(controlCodes.includes('control.work_journal_state_invalid'), false);
  assert.equal(controlCodes.includes('control.scheduler_state_invalid'), false);
});

test('Work Journal requires the independently anchored semantic head', async () => {
  const temporaryRoot = await copyCommittedPackage();
  const journal = JSON.parse(await readFile(
    `${temporaryRoot}/contracts/control-plane/work-journal.json`,
  ));
  journal.work_items[0].dependencies = [];
  await writeControlPlaneState(temporaryRoot, journal);
  const report = await buildValidationReport(temporaryRoot);
  const controlCodes = report.checks.find(({id}) => id === 'control-plane-contract').codes;
  assert.ok(controlCodes.includes('schema.constraint'));
  assert.ok(controlCodes.includes('control.work_journal_state_invalid'));
});

test('Work Journal rejects every orphan lifecycle record kind', async () => {
  const orphanRows = [
    ['enqueue-receipt:orphan-001', 'enqueue', 'queued', {}],
    ['receipt:orphan-lease-001', 'lease', 'leased', {owner_agent_id: 'agent:primary-001',
      acquired_tick: 1, expires_tick: 301, lease_status: 'active'}],
    ['receipt:orphan-start-001', 'start', 'executing',
      {owner_agent_id: 'agent:primary-001', started_tick: 2}],
    ['receipt:orphan-retry-001', 'retry', 'retry_wait', {retry_count: 1,
      failure_retryable: true, failure_observed_tick: 2, selected_retry_delay_ticks: 1000,
      retry_eligible_tick: 1002}],
    ['cancellation-receipt:orphan-001', 'cancellation', 'cancelled', {}],
    ['resume-receipt:orphan-001', 'resume', 'queued', {}],
    ['receipt:orphan-completion-001', 'completion', 'failed', {}],
    ['receipt:orphan-rejection-001', 'rejection', 'rejected',
      {rejection_code: 'control.work_version_stale'}],
    ['receipt:orphan-recovery-001', 'recovery', 'queued', {recovery_interruption_count: 1,
      resulting_retry_count: 0, recovery_tick: 301, recovery_lease_status: 'expired',
      recovery_decision: 'requeue'}],
  ];
  for (const [receiptId, receiptKind, state, details] of orphanRows) {
    const temporaryRoot = await copyCommittedPackage();
    const journalPath = `${temporaryRoot}/contracts/control-plane/work-journal.json`;
    const journal = JSON.parse(await readFile(journalPath));
    const work = journal.work_items[0];
    journal.receipts.push(authenticateJournalRecord({
      receipt_id: receiptId, receipt_kind: receiptKind, journal_sequence: 2,
      work_id: work.work_id, work_version: work.work_version,
      lease_id: ['lease', 'start', 'retry', 'recovery'].includes(receiptKind)
        ? 'lease:orphan-001' : null, state,
      operation_digest: 'a'.repeat(64), semantic_state_digest: 'd'.repeat(64),
      ...details,
    }));
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
  for (const receipt of subject.document.initial.prior_lease_receipts) {
    Object.assign(receipt, {
      acquired_tick: 999698, expires_tick: 999998,
      started_tick: receipt.receipt_kind === 'start' ? 999698 : null,
    });
    Object.assign(receipt, signControlPlaneReceipt('work_lease', leaseFields(receipt)));
  }
  authenticateScenarioHead(subject.document.initial);
  subject.document.action.current_tick = 999997;
  authenticateScenarioScheduler(subject.document.initial, subject.document.action.current_tick);
  const observed = await observeControlPlaneScenario(subject, packageRoot);
  assert.equal(observed.verdict, 'pass');
  assert.equal(observed.terminal_state, 'failed');
  assert.equal(observed.outputs.includes('retry eligibility tick overflow produced terminal failure'), true);
  assert.equal(observed.codes.includes('control.post_state_invalid'), false);

  const horizon = JSON.parse(await readFile(new URL('./scenarios/control-plane/first-retry-recorded.json', import.meta.url)));
  Object.assign(horizon.subject.document.initial.work, {
    lease_acquired_tick: 998600, lease_expires_tick: 998900,
  });
  for (const receipt of horizon.subject.document.initial.prior_lease_receipts) {
    Object.assign(receipt, {
      acquired_tick: 998600, expires_tick: 998900,
      started_tick: receipt.receipt_kind === 'start' ? 998600 : null,
    });
    Object.assign(receipt, signControlPlaneReceipt('work_lease', leaseFields(receipt)));
  }
  authenticateScenarioHead(horizon.subject.document.initial);
  horizon.subject.document.action.current_tick = 998701;
  authenticateScenarioScheduler(horizon.subject.document.initial, horizon.subject.document.action.current_tick);
  const horizonResult = await observeControlPlaneScenario(horizon.subject, packageRoot);
  assert.equal(horizonResult.verdict, 'pass');
  assert.equal(horizonResult.terminal_state, 'failed');
  assert.equal(horizonResult.outputs.includes('retry eligibility tick overflow produced terminal failure'), true);
});

test('dispatch and journal append reject arithmetic beyond their closed domains', async () => {
  const dispatchFixture = JSON.parse(await readFile(new URL('./scenarios/control-plane/dequeue-acknowledges-after-receipt.json', import.meta.url)));
  dispatchFixture.subject.document.action.current_tick = 1000000;
  dispatchFixture.subject.document.initial.scheduler_observed_tick = 1000000;
  assert.deepEqual((await observeControlPlaneScenario(dispatchFixture.subject, packageRoot)).codes,
    ['control.lease_tick_overflow']);

  const failureFixture = JSON.parse(await readFile(new URL('./scenarios/control-plane/retry-ceiling-terminal-failure.json', import.meta.url)));
  failureFixture.subject.document.initial.journal_head_sequence = 501;
  failureFixture.subject.document.initial.journal_head_digest = 'f'.repeat(64);
  Object.assign(failureFixture.subject.document.initial.journal_head_receipt, {
    head_sequence: 501, head_digest: 'f'.repeat(64),
  });
  Object.assign(failureFixture.subject.document.initial.journal_head_receipt, signControlPlaneReceipt(
    'work_journal_head', journalHeadFields(failureFixture.subject.document.initial.journal_head_receipt),
  ));
  assert.deepEqual((await observeControlPlaneScenario(failureFixture.subject, packageRoot)).codes,
    ['schema.constraint']);

  const recoveryFixture = JSON.parse(await readFile(new URL('./scenarios/control-plane/in-flight-work-recovers-agent-crash.json', import.meta.url)));
  const recoveryInitial = recoveryFixture.subject.document.initial;
  recoveryFixture.subject.document.action.recovery_tick = 999000;
  recoveryInitial.journal_head_sequence = 501;
  recoveryInitial.journal_head_digest = 'f'.repeat(64);
  Object.assign(recoveryInitial.journal_head_receipt, {
    head_sequence: 501, head_digest: 'f'.repeat(64),
  });
  Object.assign(recoveryInitial.journal_head_receipt, signControlPlaneReceipt(
    'work_journal_head', journalHeadFields(recoveryInitial.journal_head_receipt),
  ));
  recoveryFixture.subject.document.action.expected_journal_head_sequence = 501;
  recoveryFixture.subject.document.action.expected_journal_head_digest = 'f'.repeat(64);
  assert.deepEqual((await observeControlPlaneScenario(recoveryFixture.subject, packageRoot)).codes,
    ['schema.constraint']);
});
