import {createHash} from 'node:crypto';

import {checkTransitionTable} from './package-checks.mjs';
import {childWorkInvocationIsValid} from './child-work-validation.mjs';
import {verifyControlPlaneReceipt} from './control-plane-authentication.mjs';
import {controlPlaneOutcomeFieldsAreValid} from './control-plane-outcome.mjs';
import {schemaErrorCode, validateAgainstSchemaPath} from './json-schema.mjs';
import {controlPlaneEvidenceCodes} from './control-plane-evidence.mjs';
import {readPackageFile} from './safe-path.mjs';
import {canonicalJson} from './semantic-kernel-core.mjs';

const instanceBindings = [
  ['contracts/control-plane/work-journal.json', 'contracts/schemas/work-journal.schema.json'],
  ['contracts/control-plane/scheduler-state.json', 'contracts/schemas/scheduler-state.schema.json'],
  ['contracts/control-plane/agent-state.json', 'contracts/schemas/agent-state.schema.json'],
  ['contracts/control-plane/control-command.json', 'contracts/schemas/control-channel-command.schema.json'],
  ['contracts/control-plane/child-work-invocation.json', 'contracts/schemas/child-work-invocation.schema.json'],
  ['contracts/control-plane/recovery-matrix.json', 'contracts/schemas/control-plane-recovery-matrix.schema.json'],
  ['conformance/evidence/control-plane-recovery-report.json', 'contracts/schemas/control-plane-recovery-report.schema.json'],
];

const transitionPaths = [
  'contracts/transitions/work-queue-lifecycle.json',
  'contracts/transitions/retry-lifecycle.json',
  'contracts/transitions/cancellation-lifecycle.json',
  'contracts/transitions/readiness-lifecycle.json',
  'contracts/transitions/agent-lifecycle.json',
  'contracts/transitions/control-channel-lifecycle.json',
  'contracts/transitions/exclusive-writer-lifecycle.json',
];

const transitionInventories = new Map([
  ['contracts/transitions/work-queue-lifecycle.json', {
    prefix: 'TR-CPWORK-',
    rowsDigest: '2f480647aa222a82ae43d4af35d676caab5955fb00825fdd6ced4d02ede9a404',
    states: ['absent', 'queued', 'leased', 'executing', 'terminal'],
    commands: ['enqueue_work', 'dispatch_work', 'acknowledge_work', 'complete_work', 'recover_work'],
  }],
  ['contracts/transitions/retry-lifecycle.json', {
    prefix: 'TR-CPRETRY-',
    rowsDigest: '8be3a0f6cba8cb9fb0c703f0c01928675250a3a1eec26ab0fac8f65fb84578d6',
    states: ['executing', 'retry_wait', 'failed'],
    commands: ['record_retry', 'record_terminal_failure', 'retry_work'],
  }],
  ['contracts/transitions/cancellation-lifecycle.json', {
    prefix: 'TR-CPCANCEL-',
    rowsDigest: '34047fa8894cba4db4794f8b4d9624fa80f98ae423890f951462b85e6bec0d3e',
    states: ['queued', 'leased', 'executing', 'retry_wait', 'cancelled', 'succeeded', 'failed'],
    commands: ['cancel_work', 'resume_work'],
  }],
  ['contracts/transitions/readiness-lifecycle.json', {
    prefix: 'TR-CPREADY-',
    rowsDigest: 'cd2c2252d8b69246c276da19af1005e0af66b3e80617d38c41d003ffadfb8a0a',
    states: ['starting', 'ready', 'blocked'], commands: ['evaluate_readiness', 'dependency_lost'],
  }],
  ['contracts/transitions/agent-lifecycle.json', {
    prefix: 'TR-CPAGENT-',
    rowsDigest: '2e61383c92b4db87b896f9eea7e8d130ee3e916dd0abb19ee2c88aa3192ebc66',
    states: ['stopped', 'starting', 'recovering', 'ready', 'draining', 'blocked'],
    commands: ['start_agent', 'crash_agent', 'recover_agent', 'stop_agent'],
  }],
  ['contracts/transitions/control-channel-lifecycle.json', {
    prefix: 'TR-CPCHANNEL-',
    rowsDigest: '1e658046f5c7aaeaf4e6bec507174f30a9b64158a92e7a35c3473a9a6f509f9e',
    states: ['closed', 'open'], commands: ['open_control_channel', 'submit_control_command', 'close_control_channel'],
  }],
  ['contracts/transitions/exclusive-writer-lifecycle.json', {
    prefix: 'TR-CPWRITER-',
    rowsDigest: '4c5474dbc6b88ab2d769f08a40ab21d2101cf7e8eb8a8dbe0a0e8c0e048954cc',
    states: ['unheld', 'held'], commands: ['acquire_writer', 'retain_writer', 'release_writer'],
  }],
]);

const recoveryInventory = [
  ['RC-CP-001', 'before_enqueue_commit', 'deny'],
  ['RC-CP-002', 'after_enqueue_commit', 'resume'],
  ['RC-CP-003', 'after_lease_receipt_before_ack', 'preserve'],
  ['RC-CP-004', 'after_dequeue_ack_before_execution', 'requeue'],
  ['RC-CP-005', 'during_execution_without_completion_receipt', 'requeue'],
  ['RC-CP-006', 'after_completion_receipt_before_terminal_record', 'preserve'],
  ['RC-CP-007', 'after_cancellation_receipt_before_child_stop', 'preserve'],
  ['RC-CP-008', 'restart_with_cancelled_work', 'preserve'],
  ['RC-CP-009', 'repeated_interruption_with_budget', 'requeue'],
  ['RC-CP-010', 'repeated_interruption_exhausted', 'fail'],
  ['RC-CP-011', 'unknown_mutation_completion', 'block'],
  ['RC-CP-012', 'exclusive_writer_lost', 'block'],
  ['RC-CP-013', 'work_journal_unavailable', 'block'],
  ['RC-CP-014', 'stale_work_or_lease_base', 'deny'],
  ['RC-CP-015', 'child_output_without_completion_receipt', 'deny'],
].map(([caseId, interruptionPoint, decision]) => ({
  case_id: caseId,
  interruption_point: interruptionPoint,
  default_decision: decision,
  terminal_result: `${decision} with unchanged semantic truth`,
  failure_result: 'control.recovery_precondition_failed; state unchanged',
}));
const recoveryRowsDigest = '32a4d35d7b661551872babf4015dd129b061b4915e5e3a64621a87d7434d1b84';

function canonicalDigest(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function journalCancellationFields(cancellation) {
  return [cancellation.receipt_id, cancellation.cancellation_id, cancellation.work_id,
    cancellation.work_version, cancellation.idempotency_key, cancellation.requested_by,
    cancellation.journal_sequence, cancellation.reason_code, cancellation.resume_count,
    cancellation.resume_ceiling];
}

function journalEnqueueFields(receipt) {
  return [receipt.receipt_id, receipt.work_id, receipt.work_version, receipt.idempotency_key,
    receipt.input_digest, receipt.base_head_sequence, receipt.base_head_digest,
    receipt.journal_sequence];
}

function journalResumeFields(receipt) {
  return [receipt.receipt_id, receipt.work_id, receipt.cancelled_work_version,
    receipt.resumed_work_version, receipt.idempotency_key, receipt.cancellation_receipt_id,
    receipt.resume_count, receipt.journal_sequence];
}

const authorityByTransitionCommand = new Map([
  ['enqueue_work', 'work_submitter'], ['dispatch_work', 'scheduler'],
  ['acknowledge_work', 'mdplace_agent'], ['complete_work', 'mdplace_agent'], ['recover_work', 'mdplace_agent'],
  ['record_retry', 'mdplace_agent'], ['record_terminal_failure', 'mdplace_agent'], ['retry_work', 'scheduler'],
  ['cancel_work', 'vault_owner'], ['resume_work', 'vault_owner'],
  ['evaluate_readiness', 'mdplace_agent'], ['dependency_lost', 'mdplace_agent'],
  ['start_agent', 'launchd_supervisor'], ['crash_agent', 'operating_system'],
  ['recover_agent', 'mdplace_agent'], ['stop_agent', 'launchd_supervisor'],
  ['open_control_channel', 'mdplace_agent'], ['submit_control_command', 'control_client'],
  ['close_control_channel', 'mdplace_agent'], ['acquire_writer', 'mdplace_agent'],
  ['retain_writer', 'mdplace_agent'], ['release_writer', 'mdplace_agent'],
]);

function transitionTarget(prefix, state, command) {
  if (prefix === 'TR-CPWORK-') {
    if (command === 'enqueue_work') return state === 'absent' ? 'queued' : state;
    if (state === 'queued' && command === 'dispatch_work') return 'leased';
    if (state === 'leased' && command === 'acknowledge_work') return 'executing';
    if (state === 'executing' && command === 'complete_work') return 'terminal';
    if (command === 'recover_work' && state === 'leased') return 'queued';
    if (command === 'recover_work' && state === 'executing') return 'retry_wait';
  }
  if (prefix === 'TR-CPRETRY-') {
    if (state === 'executing' && command === 'record_retry') return 'retry_wait';
    if (state === 'executing' && command === 'record_terminal_failure') return 'failed';
    if (state === 'retry_wait' && command === 'retry_work') return 'leased';
  }
  if (prefix === 'TR-CPCANCEL-') {
    if (command === 'cancel_work' && ['queued', 'leased', 'executing', 'retry_wait', 'cancelled'].includes(state)) return 'cancelled';
    if (command === 'resume_work' && ['queued', 'cancelled'].includes(state)) return 'queued';
  }
  if (prefix === 'TR-CPREADY-') {
    if (command === 'dependency_lost') return 'blocked';
    if (command === 'evaluate_readiness' && ['starting', 'blocked'].includes(state)) return 'ready';
  }
  if (prefix === 'TR-CPAGENT-') {
    if (command === 'start_agent' && state === 'stopped') return 'starting';
    if (command === 'crash_agent' && ['starting', 'recovering', 'ready', 'draining'].includes(state)) return 'recovering';
    if (command === 'recover_agent' && ['recovering', 'blocked'].includes(state)) return 'starting';
    if (command === 'stop_agent') return state === 'ready' ? 'draining' : 'stopped';
  }
  if (prefix === 'TR-CPCHANNEL-') {
    if (command === 'open_control_channel') return 'open';
    if (command === 'close_control_channel') return 'closed';
    if (command === 'submit_control_command' && state === 'open') return 'open';
  }
  if (prefix === 'TR-CPWRITER-') {
    if (state === 'unheld' && command === 'acquire_writer') return 'held';
    if (state === 'held' && command === 'retain_writer') return 'held';
    if (state === 'held' && command === 'release_writer') return 'unheld';
  }
  return null;
}

function transitionSemanticsAreExact(table, inventory) {
  if (!Array.isArray(table.transitions) || table.transitions.length !== inventory.states.length * inventory.commands.length ||
      canonicalDigest(table.transitions) !== inventory.rowsDigest) return false;
  return table.transitions.every((row, index) => {
    const state = inventory.states[Math.floor(index / inventory.commands.length)];
    const command = inventory.commands[index % inventory.commands.length];
    const target = transitionTarget(inventory.prefix, state, command);
    const allowed = target !== null;
    return row.transition_id === `${inventory.prefix}${String(index + 1).padStart(3, '0')}` &&
      row.from_state === state && row.command_or_event === command && row.allowed === allowed &&
      row.terminal_state === (target ?? state) &&
      sameOrder(row.actor_authority?.roles, [authorityByTransitionCommand.get(command)]) &&
      row.actor_authority?.quorum === 1 && row.actor_authority?.distinct_actors === false &&
      row.actor_authority?.delegation === 'forbidden' &&
      row.failure_result?.code === (allowed ? 'control.precondition_failed' : 'control.illegal_transition') &&
      row.failure_result?.state_effect === 'unchanged';
  });
}

function sameOrder(left, right) {
  return Array.isArray(left) && left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function duplicate(values) {
  return new Set(values).size !== values.length;
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function workJournalStateValid(journal) {
  if (!Array.isArray(journal?.work_items) || !Array.isArray(journal?.receipts)) return false;
  if (journal.work_items.some((work) => !record(work)) || journal.receipts.some((receipt) => !record(receipt))) return false;
  const workIds = journal.work_items.map((work) => work.work_id);
  const idempotencyKeys = journal.work_items.map((work) => work.idempotency_key);
  const receiptIds = journal.receipts.map((receipt) => receipt.receipt_id);
  const sequences = journal.receipts.map((receipt) => receipt.journal_sequence);
  if (duplicate(workIds) || duplicate(idempotencyKeys) || duplicate(receiptIds) || duplicate(sequences) ||
      sequences.some((sequence) => sequence > journal.head_sequence)) return false;
  const orderedReceipts = [...journal.receipts].sort((left, right) => left.journal_sequence - right.journal_sequence);
  const expectedHeadSequence = orderedReceipts.at(-1)?.journal_sequence ?? 0;
  const receiptsAreContiguous = orderedReceipts.every((receipt, index) => receipt.journal_sequence === index + 1);
  if (!receiptsAreContiguous || journal.head_sequence !== expectedHeadSequence ||
      journal.head_digest !== canonicalDigest(orderedReceipts)) return false;
  const workById = new Map(journal.work_items.map((work) => [work.work_id, work]));
  if (journal.receipts.some((receipt) => {
    const work = workById.get(receipt.work_id);
    return work === undefined || receipt.work_version > work.work_version;
  })) return false;
  return journal.work_items.every((work) => {
    const enqueueReceipt = work.enqueue_receipt;
    const matchingEnqueueReceipt = journal.receipts.find((receipt) =>
      receipt.receipt_id === enqueueReceipt?.receipt_id);
    const enqueueBaseReceipts = orderedReceipts.filter((receipt) =>
      receipt.journal_sequence <= enqueueReceipt?.base_head_sequence);
    const enqueueValid = enqueueReceipt !== null && enqueueReceipt.work_id === work.work_id &&
      enqueueReceipt.work_version === 1 && enqueueReceipt.work_version <= work.work_version &&
      enqueueReceipt.idempotency_key === work.idempotency_key &&
      enqueueReceipt.input_digest === work.input_digest &&
      enqueueReceipt.journal_sequence === enqueueReceipt.base_head_sequence + 1 &&
      enqueueReceipt.base_head_digest === canonicalDigest(enqueueBaseReceipts) &&
      matchingEnqueueReceipt?.receipt_kind === 'enqueue' &&
      matchingEnqueueReceipt.journal_sequence === enqueueReceipt.journal_sequence &&
      matchingEnqueueReceipt.work_id === work.work_id && matchingEnqueueReceipt.work_version === 1 &&
      matchingEnqueueReceipt.state === 'queued' &&
      verifyControlPlaneReceipt('work_enqueue', journalEnqueueFields(enqueueReceipt), enqueueReceipt);
    const leaseBound = ['leased', 'executing'].includes(work.state);
    const leaseValid = leaseBound
      ? work.lease !== null && work.lease.work_id === work.work_id &&
        work.lease.work_version === work.work_version && work.lease.expires_tick > work.lease.acquired_tick &&
        work.lease.expires_tick - work.lease.acquired_tick <= journal.limits.lease_duration_ticks
      : work.lease === null;
    const retryValid = work.state === 'retry_wait'
      ? Number.isInteger(work.retry_eligible_tick)
      : work.retry_eligible_tick === null;
    const terminal = ['cancelled', 'succeeded', 'failed'].includes(work.state);
    const result = work.result;
    const cancellation = work.cancellation;
    const matchingCancellationReceipt = cancellation === null ? null
      : journal.receipts.find((receipt) => receipt.receipt_id === cancellation.receipt_id);
    const cancellationValid = cancellation === null
      ? work.state !== 'cancelled'
      : cancellation.work_id === work.work_id && cancellation.idempotency_key === work.idempotency_key &&
        cancellation.work_version <= work.work_version && cancellation.journal_sequence <= journal.head_sequence &&
        cancellation.resume_count <= work.resume_count && cancellation.resume_ceiling === journal.limits.max_resume_count &&
        (work.state !== 'cancelled' || cancellation.work_version === work.work_version) &&
        matchingCancellationReceipt?.receipt_kind === 'cancellation' &&
        matchingCancellationReceipt.journal_sequence === cancellation.journal_sequence &&
        matchingCancellationReceipt.work_id === work.work_id &&
        matchingCancellationReceipt.work_version === cancellation.work_version &&
        matchingCancellationReceipt.state === 'cancelled' &&
        verifyControlPlaneReceipt('work_journal_cancellation', journalCancellationFields(cancellation), cancellation);
    const resumeReceipt = work.resume_receipt;
    const matchingResumeReceipt = resumeReceipt === null ? null
      : journal.receipts.find((receipt) => receipt.receipt_id === resumeReceipt.receipt_id);
    const resumeValid = work.resume_count === 0
      ? resumeReceipt === null
      : resumeReceipt !== null && work.resume_count === 1 && cancellation !== null &&
        resumeReceipt.work_id === work.work_id && resumeReceipt.idempotency_key === work.idempotency_key &&
        resumeReceipt.cancelled_work_version === cancellation.work_version &&
        resumeReceipt.resumed_work_version === cancellation.work_version + 1 &&
        resumeReceipt.resumed_work_version <= work.work_version &&
        resumeReceipt.cancellation_receipt_id === cancellation.receipt_id &&
        resumeReceipt.journal_sequence > cancellation.journal_sequence &&
        resumeReceipt.journal_sequence <= journal.head_sequence &&
        matchingResumeReceipt?.receipt_kind === 'resume' &&
        matchingResumeReceipt.journal_sequence === resumeReceipt.journal_sequence &&
        matchingResumeReceipt.work_id === work.work_id &&
        matchingResumeReceipt.work_version === resumeReceipt.resumed_work_version &&
        matchingResumeReceipt.state === 'queued' &&
        verifyControlPlaneReceipt('work_resume', journalResumeFields(resumeReceipt), resumeReceipt);
    const matchingCompletionReceipt = terminal
      ? journal.receipts.find((receipt) => receipt.receipt_id === result?.receipt_id)
      : null;
    const applicableLeaseReceipts = result?.lease_id === null || result?.lease_id === undefined
      ? []
      : journal.receipts.filter((receipt) => ['lease', 'start'].includes(receipt.receipt_kind) &&
        receipt.work_id === work.work_id && receipt.work_version <= work.work_version &&
        receipt.journal_sequence < result.journal_sequence);
    const matchingLeaseReceipt = applicableLeaseReceipts.reduce((latest, receipt) =>
      latest === null || receipt.journal_sequence > latest.journal_sequence ? receipt : latest, null);
    const outcomeFieldsValid = controlPlaneOutcomeFieldsAreValid(result, {
      retryCount: work.retry_count,
      retryCeiling: journal.limits.max_total_attempts - 1,
      recoveryInterruptionCount: work.recovery_interruption_count,
      recoveryCeiling: journal.limits.max_recovery_interruptions,
    });
    const resultValid = terminal
      ? work.result !== null && work.result.outcome === work.state && work.result.work_version === work.work_version &&
        work.result.journal_sequence <= journal.head_sequence &&
        outcomeFieldsValid && matchingCompletionReceipt?.receipt_kind === 'completion' &&
        matchingCompletionReceipt.journal_sequence === result.journal_sequence &&
        matchingCompletionReceipt.work_id === work.work_id &&
        matchingCompletionReceipt.work_version === work.work_version &&
        matchingCompletionReceipt.lease_id === result.lease_id &&
        matchingCompletionReceipt.state === work.state &&
        (result.outcome !== 'cancelled' ||
          result.journal_sequence === cancellation?.journal_sequence + 1) &&
        ((result.outcome === 'cancelled' && result.lease_id === null) ||
          (typeof result.lease_id === 'string' && matchingLeaseReceipt?.lease_id === result.lease_id)) &&
        verifyControlPlaneReceipt('work_completion', [
          result.receipt_id, work.work_id, result.work_version, result.lease_id ?? '',
          result.journal_sequence, result.outcome, result.output_digest ?? '', result.code ?? '',
        ], result)
      : work.result === null;
    return enqueueValid && leaseValid && retryValid && cancellationValid && resumeValid && resultValid &&
      work.recovery_interruption_count <= journal.limits.max_recovery_interruptions;
  });
}

function schedulerStateValid(scheduler, journal, agent) {
  if (!Array.isArray(scheduler?.eligible_queue) || !Array.isArray(scheduler?.active_leases)) return false;
  if (scheduler.eligible_queue.some((entry) => !record(entry)) || scheduler.active_leases.some((lease) => !record(lease))) return false;
  const queuedIds = scheduler.eligible_queue.map((entry) => entry.work_id);
  const leasedIds = scheduler.active_leases.map((lease) => lease.lease_id);
  const leasedWorkIds = scheduler.active_leases.map((lease) => lease.work_id);
  const journalWork = Array.isArray(journal?.work_items) ? journal.work_items : [];
  const expectedQueuedWork = journalWork.filter(({state}) => ['queued', 'retry_wait'].includes(state));
  const expectedActiveWork = journalWork.filter(({state, lease}) =>
    ['leased', 'executing'].includes(state) && lease?.status === 'active');
  const queueMatchesJournal = scheduler.eligible_queue.length === expectedQueuedWork.length &&
    scheduler.eligible_queue.every((entry) => expectedQueuedWork.some((work) =>
      entry.work_id === work.work_id && entry.work_version === work.work_version &&
      entry.input_digest === work.input_digest &&
      entry.eligible_tick === (work.retry_eligible_tick ?? 0)));
  const leasesMatchJournal = scheduler.active_leases.length === expectedActiveWork.length &&
    scheduler.active_leases.every((lease) => expectedActiveWork.some((work) =>
      lease.lease_id === work.lease.lease_id && lease.work_id === work.work_id &&
      lease.work_version === work.work_version && lease.owner_agent_id === work.lease.owner_agent_id &&
      lease.acquired_tick === work.lease.acquired_tick && lease.expires_tick === work.lease.expires_tick));
  return scheduler.agent_id === agent?.persistent_agent_id && scheduler.vault_id === agent?.vault_id &&
    journal?.vault_id === agent?.vault_id && scheduler.readiness === agent?.state &&
    scheduler.journal_head_sequence === journal?.head_sequence &&
    scheduler.journal_head_digest === journal?.head_digest &&
    !duplicate(queuedIds) && !duplicate(leasedIds) && !duplicate(leasedWorkIds) &&
    scheduler.active_leases.length <= scheduler.limits.max_concurrent_work &&
    queueMatchesJournal && leasesMatchJournal && queuedIds.every((id) => !leasedWorkIds.includes(id)) &&
    scheduler.active_leases.every((lease) =>
      lease.status === 'active' && lease.expires_tick > lease.acquired_tick &&
      lease.expires_tick - lease.acquired_tick <= scheduler.limits.lease_duration_ticks);
}

function agentStateValid(agent) {
  const gateNames = ['exclusive_writer', 'vault_filesystem', 'semantic_kernel', 'compatibility', 'derived_views', 'work_journal', 'control_channel'];
  if (!Array.isArray(agent?.readiness_gates) || agent.readiness_gates.length !== gateNames.length ||
      agent.readiness_gates.some((gate, index) => !record(gate) || gate.ordinal !== index + 1 || gate.gate !== gateNames[index])) return false;
  if (agent.state !== 'ready') return true;
  const writer = agent.writer_lock;
  if (writer?.owner_agent_id !== agent.persistent_agent_id || writer.epoch <= 0 || writer.prior_epoch !== writer.epoch - 1 ||
      writer.retained !== true || typeof writer.token_digest !== 'string' ||
      !verifyControlPlaneReceipt('writer_lock', [
        writer.lock_id, writer.prior_epoch, writer.epoch, writer.owner_agent_id,
        writer.token_digest, writer.retained, agent.vault_id,
      ], writer, agent.persistent_agent_id)) return false;
  let previousReceiptDigest = writer.signature_digest;
  const gatesValid = agent.readiness_gates.every((gate) => {
    const valid = gate.verdict === 'pass' && gate.agent_id === agent.persistent_agent_id && gate.vault_id === agent.vault_id &&
      gate.previous_receipt_digest === previousReceiptDigest && verifyControlPlaneReceipt('readiness_gate', [
        gate.receipt_id, gate.agent_id, gate.vault_id, gate.ordinal, gate.gate,
        gate.verdict, gate.observation_digest, gate.previous_receipt_digest,
      ], gate, agent.persistent_agent_id);
    previousReceiptDigest = gate.signature_digest;
    return valid;
  });
  return writer.owner_agent_id === agent.persistent_agent_id && writer.epoch > 0 &&
    agent.writer_lock.retained === true && typeof agent.writer_lock.token_digest === 'string' &&
    agent.control_channel_state === 'open' && gatesValid;
}

function controlCommandStateValid(command, journal) {
  const peer = command?.peer;
  if (peer?.peer_credentials_verified !== true || peer.local_transport !== true ||
      peer.peer_uid !== peer.effective_uid || peer.vault_scope !== command.vault_id ||
      command.vault_id !== journal?.vault_id) return false;
  const expectedBaseKind = ['cancel', 'resume'].includes(command.command_kind) ? 'work_item'
    : command.command_kind === 'enqueue' ? 'work_journal' : null;
  if (expectedBaseKind === null) return true;
  if (!Array.isArray(command.base_references)) return false;
  const matchingBases = command.base_references.filter((base) => record(base) && base.kind === expectedBaseKind);
  if (command.base_references.length !== 1 || matchingBases.length !== 1) return false;
  const base = matchingBases[0];
  if (expectedBaseKind === 'work_journal') {
    return base.reference_id === journal?.journal_id && base.version === journal?.head_sequence &&
      base.digest === journal?.head_digest;
  }
  const work = journal?.work_items?.find(({work_id: id}) => id === base.reference_id);
  return work !== undefined && base.version === work.work_version && base.digest === canonicalDigest(work);
}

const scenarioCategories = new Set([
  'positive', 'negative', 'exact_boundary', 'stale_state',
  'authority_denial', 'illegal_transition', 'crash_recovery',
]);

function result(codes) {
  const uniqueCodes = [...new Set(codes)];
  return {id: 'control-plane-contract', verdict: uniqueCodes.length === 0 ? 'pass' : 'fail', codes: uniqueCodes};
}

async function readJson(packageRoot, path) {
  const read = await readPackageFile(packageRoot, path);
  if (read.status !== 'present') return null;
  try {
    return JSON.parse(read.content.toString('utf8'));
  } catch {
    return null;
  }
}

export async function checkControlPlaneContract(packageRoot, manifest, conformance, traceability) {
  const codes = [];
  const instances = new Map();
  for (const [instancePath, schemaPath] of instanceBindings) {
    const instance = await readJson(packageRoot, instancePath);
    if (instance === null) {
      codes.push('control.instance_missing');
      continue;
    }
    instances.set(instancePath, instance);
    const schemaErrors = await validateAgainstSchemaPath(packageRoot, schemaPath, instance);
    const code = schemaErrorCode(schemaErrors);
    if (code !== null) codes.push(code);
  }
  for (const path of transitionPaths) {
    const table = await readJson(packageRoot, path);
    if (table === null) {
      codes.push('control.transition_missing');
      continue;
    }
    const check = checkTransitionTable(table, path);
    codes.push(...check.codes);
    const inventory = transitionInventories.get(path);
    if (inventory === undefined || !sameOrder(table.states, inventory.states) || !sameOrder(table.commands, inventory.commands) ||
        !transitionSemanticsAreExact(table, inventory)) {
      codes.push('control.transition_inventory_invalid');
    }
  }

  if (!workJournalStateValid(instances.get('contracts/control-plane/work-journal.json'))) {
    codes.push('control.work_journal_state_invalid');
  }
  if (!schedulerStateValid(
    instances.get('contracts/control-plane/scheduler-state.json'),
    instances.get('contracts/control-plane/work-journal.json'),
    instances.get('contracts/control-plane/agent-state.json'),
  )) {
    codes.push('control.scheduler_state_invalid');
  }
  if (!agentStateValid(instances.get('contracts/control-plane/agent-state.json'))) {
    codes.push('control.agent_state_invalid');
  }
  if (!controlCommandStateValid(
    instances.get('contracts/control-plane/control-command.json'),
    instances.get('contracts/control-plane/work-journal.json'),
  )) {
    codes.push('control.command_state_invalid');
  }
  if (!childWorkInvocationIsValid(instances.get('contracts/control-plane/child-work-invocation.json'))) {
    codes.push('control.child_work_state_invalid');
  }
  const recoveryMatrix = instances.get('contracts/control-plane/recovery-matrix.json');
  const recoveryRows = Array.isArray(recoveryMatrix?.rows) ? recoveryMatrix.rows : [];
  if (recoveryRows.length !== recoveryInventory.length || canonicalDigest(recoveryRows) !== recoveryRowsDigest ||
      recoveryRows.some((row, index) => {
    const expected = recoveryInventory[index];
    return Object.entries(expected).some(([key, value]) => row?.[key] !== value);
  })) {
    codes.push('control.recovery_inventory_invalid');
  }

  const declaredEntries = Array.isArray(conformance?.fixtures) ? conformance.fixtures : [];
  const classifiedEntries = await Promise.all(declaredEntries.map(async (entry) => {
    const fixture = typeof entry?.path === 'string'
      ? await readJson(packageRoot, `conformance/${entry.path}`)
      : null;
    const controlPlane = (typeof entry?.fixture_id === 'string' && entry.fixture_id.startsWith('FIX-CP-')) ||
      (typeof entry?.path === 'string' && entry.path.startsWith('scenarios/control-plane/')) ||
      fixture?.subject?.kind === 'control_plane' ||
      fixture?.subject?.schema === 'contracts/schemas/control-plane-scenario.schema.json';
    return {entry, fixture, controlPlane};
  }));
  const controlEntries = classifiedEntries.filter(({controlPlane}) => controlPlane);
  if (controlEntries.length !== 25) codes.push('control.scenario_count_invalid');
  const scenarioIds = [];
  const categories = new Set();
  const authoritySources = new Set();
  for (const {entry, fixture} of controlEntries) {
    if (!entry?.fixture_id?.startsWith('FIX-CP-') ||
        !/^scenarios\/control-plane\/[a-z0-9][a-z0-9-]*\.json$/.test(entry?.path ?? '') ||
        fixture?.fixture_id !== entry.fixture_id || fixture?.category !== entry.category ||
        fixture?.subject?.kind !== 'control_plane' ||
        fixture?.subject?.schema !== 'contracts/schemas/control-plane-scenario.schema.json') {
      codes.push('control.scenario_manifest_pair_invalid');
      continue;
    }
    scenarioIds.push(fixture.subject.document?.scenario_id);
    categories.add(entry.category);
    if (fixture.subject.document?.action?.semantic_write_requested) {
      authoritySources.add(fixture.subject.document.action.authority_source);
    }
  }
  const expectedScenarioIds = Array.from({length: 25}, (_, index) => `CP-${String(index + 1).padStart(3, '0')}`);
  if (new Set(scenarioIds).size !== 25 ||
      expectedScenarioIds.some((id, index) => scenarioIds[index] !== id)) {
    codes.push('control.scenario_identity_invalid');
  }
  if ([...scenarioCategories].some((category) => !categories.has(category))) {
    codes.push('control.scenario_category_missing');
  }
  const requiredAuthoritySources = [
    'work_journal', 'scheduler', 'mdplace_agent', 'child_work',
    'control_channel', 'readiness', 'retry', 'queue',
  ];
  if (requiredAuthoritySources.some((source) => !authoritySources.has(source))) {
    codes.push('control.semantic_authority_coverage_missing');
  }

  const controlTrace = (Array.isArray(traceability?.records) ? traceability.records : [])
    .filter((record) => typeof record?.requirement_id === 'string' && record.requirement_id.startsWith('REQ-CP-'));
  for (const {entry, fixture} of controlEntries) {
    const expectedRequirementIds = controlTrace
      .filter(({positive_fixture_ids: positive = [], negative_fixture_ids: negative = []}) =>
        positive.includes(entry?.fixture_id) || negative.includes(entry?.fixture_id))
      .map(({requirement_id: id}) => id);
    if (!sameOrder(entry?.requirement_ids, expectedRequirementIds) ||
        !sameOrder(fixture?.requirement_ids, expectedRequirementIds)) {
      codes.push('control.fixture_traceability_invalid');
    }
  }

  const recovery = await readJson(packageRoot, 'conformance/evidence/control-plane-recovery-report.json');
  const fixtureIds = controlEntries.map(({entry}) => entry?.fixture_id);
  if (recovery?.validator_version !== manifest?.validator_version ||
      recovery?.scenario_count !== 25 ||
      !Array.isArray(recovery?.fixture_ids) ||
      recovery.fixture_ids.length !== 25 ||
      fixtureIds.some((id, index) => recovery.fixture_ids[index] !== id)) {
    codes.push('control.recovery_evidence_invalid');
  }
  codes.push(...await controlPlaneEvidenceCodes(packageRoot, recovery, controlEntries.map(({entry}) => entry)));

  const decisions = new Map((Array.isArray(traceability?.decisions) ? traceability.decisions : [])
    .filter(record).map((decision) => [decision.decision_id, decision]));
  const expectedDecisions = [
    ['DEC-026', 'https://github.com/jidankim/mdplace/issues/26#issuecomment-5187140948'],
    ['DEC-028', 'https://github.com/jidankim/mdplace/issues/28#issuecomment-5196131324'],
  ];
  if (expectedDecisions.some(([id, url]) => {
    const decision = decisions.get(id);
    return decision?.url !== url || decision?.status !== 'accepted' || decision?.use !== 'input_without_reopening';
  })) {
    codes.push('control.decision_invalid');
  }
  return result(codes);
}
