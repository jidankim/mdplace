import {createHash} from 'node:crypto';

import {checkTransitionTable} from './package-checks.mjs';
import {childWorkInvocationIsValid} from './child-work-validation.mjs';
import {verifyControlPlaneReceipt} from './control-plane-authentication.mjs';
import {
  cancellationReceiptFields,
  completionReceiptFields,
  controlPlaneLimits,
  controlPlaneSemanticHead,
  enqueueReceiptFields,
  readinessGateReceiptFields,
  resumeReceiptFields,
  vaultOwnerReceiptFields,
  writerLockReceiptFields,
} from './control-plane-contract-values.mjs';
import {controlPlaneOutcomeFieldsAreValid} from './control-plane-outcome.mjs';
import {schemaErrorCode, validateAgainstSchemaPath} from './json-schema.mjs';
import {controlPlaneEvidenceCodes} from './control-plane-evidence.mjs';
import {replayControlPlaneLifecycle} from './control-plane-lifecycle-replay.mjs';
import {readPackageFile} from './safe-path.mjs';
import {canonicalJson} from './semantic-kernel-core.mjs';

const instanceBindings = [
  ['contracts/control-plane/work-journal.json', 'contracts/schemas/work-journal.schema.json'],
  ['contracts/control-plane/scheduler-state.json', 'contracts/schemas/scheduler-state.schema.json'],
  ['contracts/control-plane/agent-state.json', 'contracts/schemas/agent-state.schema.json'],
  ['contracts/control-plane/launchagent-supervision-profile.json', 'contracts/schemas/launchagent-supervision-profile.schema.json'],
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
  'contracts/transitions/launchagent-supervision-lifecycle.json',
];

const transitionInventories = new Map([
  ['contracts/transitions/work-queue-lifecycle.json', {
    prefix: 'TR-CPWORK-',
    rowsDigest: '3fdce087b29043c00761314b2d3a3c1f0601d6b8e3d978291667c417e5cc4f6f',
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
    rowsDigest: 'e6541052c8703744b48044001c5e90ed41b587fed454ee1466de9ff10e4e0946',
    states: ['queued', 'leased', 'executing', 'retry_wait', 'cancelled', 'succeeded', 'failed'],
    commands: ['cancel_work', 'resume_work'],
  }],
  ['contracts/transitions/readiness-lifecycle.json', {
    prefix: 'TR-CPREADY-',
    rowsDigest: '10fd9dee0bd2ab85bb3b1531465be9c3e1f5b714b2f42886552be24b3e94c2b0',
    states: ['starting', 'ready', 'blocked'], commands: ['evaluate_readiness', 'dependency_lost'],
  }],
  ['contracts/transitions/agent-lifecycle.json', {
    prefix: 'TR-CPAGENT-',
    rowsDigest: 'dd054a8a2a2664b0535aec92f7fce66b1aea2c1d20119a5508c73950574be905',
    states: ['stopped', 'starting', 'recovering', 'ready', 'draining', 'blocked'],
    commands: ['start_agent', 'crash_agent', 'recover_agent', 'stop_agent'],
  }],
  ['contracts/transitions/control-channel-lifecycle.json', {
    prefix: 'TR-CPCHANNEL-',
    rowsDigest: '17ca616ebabe7e23e586f14e8fe6cd842fb9ea65110629c10d1dfbb20b390626',
    states: ['closed', 'diagnostic_only', 'work_admitting', 'draining'],
    commands: ['open_control_channel', 'submit_control_command', 'close_control_channel'],
  }],
  ['contracts/transitions/exclusive-writer-lifecycle.json', {
    prefix: 'TR-CPWRITER-',
    rowsDigest: '4c5474dbc6b88ab2d769f08a40ab21d2101cf7e8eb8a8dbe0a0e8c0e048954cc',
    states: ['unheld', 'held'], commands: ['acquire_writer', 'retain_writer', 'release_writer'],
  }],
  ['contracts/transitions/launchagent-supervision-lifecycle.json', {
    prefix: 'TR-CPSUP-',
    rowsDigest: '38e9620eaf4878c61f72b15bdfc42e8e203f9a3f8970841026bd0302b4a383e0',
    states: ['supervised', 'backoff', 'circuit_open', 'recovering'],
    commands: ['unexpected_exit', 'qualifying_failure', 'backoff_elapsed', 'restart_ceiling_reached', 'wake_revalidate',
      'emit_doctor_report', 'approve_owner_recovery', 'complete_recovery'],
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
  ['RC-CP-010', 'recovery_or_retry_budget_exhausted', 'fail'],
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
const recoveryRowsDigest = '6d2c5147a602134d6d5b07efd290d1b8d0b9a8e3a5737e1392ef89acf6fa2626';

function canonicalDigest(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
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
  ['unexpected_exit', 'operating_system'], ['qualifying_failure', 'mdplace_agent'],
  ['backoff_elapsed', 'launchd_supervisor'],
  ['restart_ceiling_reached', 'launchd_supervisor'], ['wake_revalidate', 'mdplace_agent'],
  ['emit_doctor_report', 'mdplace_agent'], ['approve_owner_recovery', 'vault_owner'],
  ['complete_recovery', 'mdplace_agent'],
]);

function transitionTarget(prefix, state, command) {
  if (prefix === 'TR-CPWORK-') {
    if (command === 'enqueue_work') return state === 'absent' ? 'queued' : state;
    if (state === 'queued' && command === 'dispatch_work') return 'leased';
    if (state === 'leased' && command === 'acknowledge_work') return 'executing';
    if (state === 'executing' && command === 'complete_work') return 'terminal';
    if (state === 'terminal' && command === 'complete_work') return 'terminal';
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
    if (command === 'open_control_channel' && state === 'closed') return 'diagnostic_only';
    if (command === 'open_control_channel' && state === 'diagnostic_only') return 'work_admitting';
    if (command === 'open_control_channel' && state === 'work_admitting') return 'work_admitting';
    if (command === 'close_control_channel') return 'closed';
    if (command === 'submit_control_command' && ['diagnostic_only', 'work_admitting'].includes(state)) return state;
  }
  if (prefix === 'TR-CPWRITER-') {
    if (state === 'unheld' && command === 'acquire_writer') return 'held';
    if (state === 'held' && command === 'retain_writer') return 'held';
    if (state === 'held' && command === 'release_writer') return 'unheld';
  }
  if (prefix === 'TR-CPSUP-') {
    if (state === 'supervised' && ['unexpected_exit', 'qualifying_failure'].includes(command)) return 'backoff';
    if (state === 'supervised' && command === 'restart_ceiling_reached') return 'circuit_open';
    if (state === 'supervised' && ['wake_revalidate', 'emit_doctor_report'].includes(command)) {
      return command === 'wake_revalidate' ? 'recovering' : 'supervised';
    }
    if (state === 'backoff' && ['unexpected_exit', 'backoff_elapsed', 'restart_ceiling_reached', 'emit_doctor_report'].includes(command)) {
      if (command === 'backoff_elapsed') return 'supervised';
      if (command === 'restart_ceiling_reached') return 'circuit_open';
      return 'backoff';
    }
    if (state === 'circuit_open' && ['unexpected_exit', 'qualifying_failure', 'restart_ceiling_reached', 'wake_revalidate', 'emit_doctor_report', 'approve_owner_recovery'].includes(command)) {
      return command === 'approve_owner_recovery' ? 'recovering' : 'circuit_open';
    }
    if (state === 'recovering' && ['unexpected_exit', 'qualifying_failure', 'restart_ceiling_reached', 'wake_revalidate', 'emit_doctor_report', 'complete_recovery'].includes(command)) {
      if (['unexpected_exit', 'restart_ceiling_reached'].includes(command)) return 'circuit_open';
      if (command === 'qualifying_failure') return 'backoff';
      if (command === 'complete_recovery') return 'supervised';
      return 'recovering';
    }
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
    const failureCodeIsExact = inventory.prefix === 'TR-CPSUP-'
      ? /^control\.[a-z0-9_]+$/.test(row.failure_result?.code ?? '')
      : row.failure_result?.code === (allowed ? 'control.precondition_failed' : 'control.illegal_transition');
    return row.transition_id === `${inventory.prefix}${String(index + 1).padStart(3, '0')}` &&
      row.from_state === state && row.command_or_event === command && row.allowed === allowed &&
      row.terminal_state === (target ?? state) &&
      sameOrder(row.actor_authority?.roles, [authorityByTransitionCommand.get(command)]) &&
      row.actor_authority?.quorum === 1 && row.actor_authority?.distinct_actors === false &&
      row.actor_authority?.delegation === 'forbidden' &&
      failureCodeIsExact &&
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

const journalRecordDetailFields = [
  'owner_agent_id', 'acquired_tick', 'expires_tick', 'lease_status', 'started_tick',
  'retry_count', 'failure_retryable', 'failure_observed_tick', 'selected_retry_delay_ticks',
  'retry_eligible_tick', 'recovery_interruption_count', 'resulting_retry_count',
  'recovery_tick', 'recovery_lease_status', 'recovery_decision', 'rejection_code',
];

const journalRecordDetailsByKind = new Map([
  ['enqueue', []],
  ['lease', ['owner_agent_id', 'acquired_tick', 'expires_tick', 'lease_status']],
  ['start', ['owner_agent_id', 'started_tick']],
  ['retry', ['retry_count', 'failure_retryable', 'failure_observed_tick',
    'selected_retry_delay_ticks', 'retry_eligible_tick']],
  ['cancellation', []],
  ['resume', []],
  ['completion', []],
  ['rejection', ['rejection_code']],
  ['recovery', ['recovery_interruption_count', 'resulting_retry_count',
    'recovery_tick', 'recovery_lease_status', 'recovery_decision',
    'selected_retry_delay_ticks', 'retry_eligible_tick']],
]);

function journalRecordFields(receipt) {
  return [receipt.receipt_id, receipt.receipt_kind, receipt.journal_sequence,
    receipt.work_id, receipt.work_version, receipt.lease_id ?? '', receipt.state,
    receipt.operation_digest, receipt.semantic_state_digest,
    ...journalRecordDetailFields.map((field) => receipt[field] ?? '')];
}

function journalRecordIsAuthenticated(receipt) {
  const allowedDetails = journalRecordDetailsByKind.get(receipt.receipt_kind);
  return allowedDetails !== undefined &&
    journalRecordDetailFields.every((field) => allowedDetails.includes(field) || receipt[field] === undefined) &&
    verifyControlPlaneReceipt('work_journal_record', journalRecordFields(receipt), receipt);
}

function publicLifecycleEvent(work, receipt, receipts) {
  const common = {
    kind: receipt.receipt_kind,
    version: receipt.work_version,
    leaseId: receipt.lease_id,
    declaredState: receipt.state,
  };
  switch (receipt.receipt_kind) {
    case 'lease':
      return {...common, ownerId: receipt.owner_agent_id, acquiredTick: receipt.acquired_tick,
        expiresTick: receipt.expires_tick, status: receipt.lease_status};
    case 'start': {
      const acquisition = receipts.find((candidate) => candidate.receipt_kind === 'lease' &&
        candidate.lease_id === receipt.lease_id && candidate.journal_sequence < receipt.journal_sequence);
      return {...common, ownerId: receipt.owner_agent_id, acquiredTick: acquisition?.acquired_tick,
        expiresTick: acquisition?.expires_tick, observedTick: receipt.started_tick,
        status: acquisition?.lease_status};
    }
    case 'retry':
      return {...common, priorRetryCount: receipt.retry_count - 1,
        resultingRetryCount: receipt.retry_count, observedTick: receipt.failure_observed_tick,
        selectedDelay: receipt.selected_retry_delay_ticks, retryEligibleTick: receipt.retry_eligible_tick};
    case 'cancellation': {
      const cancellation = work.cancellation_history.find(({receipt_id: id}) => id === receipt.receipt_id);
      return {...common, observedTick: cancellation?.cancellation_tick};
    }
    case 'completion': {
      const completion = work.completion_history.find(({receipt_id: id}) => id === receipt.receipt_id);
      return {...common, outcome: completion?.outcome, observedTick: completion?.completion_tick,
        failureObservedTick: completion?.failure_observed_tick};
    }
    case 'resume':
      return common;
    case 'recovery':
      return {...common, recoveryCount: receipt.recovery_interruption_count,
        resultingRetryCount: receipt.resulting_retry_count, observedTick: receipt.recovery_tick,
        status: receipt.recovery_lease_status, decision: receipt.recovery_decision,
        selectedDelay: receipt.selected_retry_delay_ticks ?? null,
        retryEligibleTick: receipt.retry_eligible_tick ?? null};
    default:
      return common;
  }
}

function workReceiptChainIsValid(work, receipts, journal) {
  const semanticDependencies = work.dependencies.filter(({kind}) => kind === 'semantic_head');
  const semanticDependency = semanticDependencies[0];
  if (receipts.length === 0 || receipts.some((receipt) =>
    receipt.semantic_state_digest !== receipts[0].semantic_state_digest ||
    !journalRecordIsAuthenticated(receipt)) ||
    semanticDependencies.length !== 1 ||
    semanticDependency.reference_id !== controlPlaneSemanticHead.referenceId ||
    semanticDependency.version !== controlPlaneSemanticHead.version ||
    semanticDependency.digest !== controlPlaneSemanticHead.digest ||
    receipts[0].semantic_state_digest !== controlPlaneSemanticHead.digest) return false;
  const replay = replayControlPlaneLifecycle(
    receipts.map((receipt) => publicLifecycleEvent(work, receipt, receipts)),
    {
      leaseDurationTicks: journal.limits.lease_duration_ticks,
      retryDelays: journal.limits.retry_delays_ms,
      retryCeiling: journal.limits.max_total_attempts - 1,
      recoveryCeiling: journal.limits.max_recovery_interruptions,
      latestDispatchTick: controlPlaneLimits.latestDispatchTick,
    },
  );
  if (replay === null) return false;
  for (const [index, {event, before}] of replay.trace.entries()) {
    const receipt = receipts[index];
    if (event.kind === 'lease' && receipt.owner_agent_id !== 'agent:primary-001') return false;
    if (event.kind === 'cancellation') {
      const cancellation = work.cancellation_history.find(({receipt_id: id}) => id === receipt.receipt_id);
      if (cancellation?.work_version !== receipt.work_version ||
          cancellation.vault_owner_receipt.lease_id !== receipt.lease_id) return false;
    }
    if (event.kind !== 'completion') continue;
    const completion = work.completion_history.find(({receipt_id: id}) => id === receipt.receipt_id);
    const preceding = journal.receipts.find(({journal_sequence: sequence}) =>
      sequence === receipt.journal_sequence - 1);
    const adjacentTerminal = before.state === 'cancelled'
      ? preceding?.receipt_kind === 'cancellation' && preceding.work_id === work.work_id &&
        preceding.work_version === receipt.work_version
      : before.state === 'failed'
        ? preceding?.receipt_kind === 'recovery' && preceding.recovery_decision === 'fail' &&
          preceding.work_id === work.work_id && preceding.work_version === receipt.work_version
        : false;
    const baseSequence = adjacentTerminal ? preceding.journal_sequence : receipt.journal_sequence - 1;
    const baseDigest = canonicalDigest([...journal.receipts]
      .filter(({journal_sequence: sequence}) => sequence <= baseSequence)
      .sort((left, right) => left.journal_sequence - right.journal_sequence));
    if (completion === undefined || receipt.state !== completion.outcome ||
        receipt.lease_id !== completion.lease_id || completion.idempotency_key !== work.idempotency_key ||
        completion.base_head_sequence !== baseSequence || completion.base_head_digest !== baseDigest ||
        (['cancelled', 'failed'].includes(before.state) && !adjacentTerminal)) return false;
    if (before.state !== 'failed') continue;
    const failedRecovery = before.failedRecovery;
    if (failedRecovery === null) return false;
    const expectedCode = failedRecovery.recoveryExhausted
      ? 'control.recovery_ceiling_exceeded'
      : failedRecovery.retryExhausted
        ? 'control.retry_ceiling_exceeded' : 'control.retry_tick_overflow';
    const expectedDelay = failedRecovery.tickOverflow
      ? journal.limits.retry_delays_ms[failedRecovery.priorRetryCount] : null;
    const failureBasisIsExact = expectedCode === 'control.recovery_ceiling_exceeded'
      ? completion.failure_retryable === null && completion.failure_observed_tick === null &&
        completion.selected_retry_delay_ticks === null
      : completion.failure_retryable === true &&
        completion.failure_observed_tick === failedRecovery.observedTick &&
        completion.selected_retry_delay_ticks === expectedDelay;
    if (completion.code !== expectedCode || !failureBasisIsExact) return false;
  }
  const {current} = replay;
  const currentLeaseMatches = ['leased', 'executing'].includes(current.state)
    ? work.lease?.lease_id === current.lease?.leaseId &&
      work.lease.owner_agent_id === current.lease.ownerId &&
      work.lease.acquired_tick === current.lease.acquiredTick &&
      work.lease.expires_tick === current.lease.expiresTick &&
      work.lease.status === current.lease.status
    : work.lease === null;
  return current.state === work.state && current.version === work.work_version &&
    current.retryCount === work.retry_count &&
    current.retryEligibleTick === work.retry_eligible_tick &&
    current.recoveryCount === work.recovery_interruption_count &&
    current.rejectionCount === work.rejection_count && currentLeaseMatches;
}

function workJournalStateValid(journal) {
  if (!Array.isArray(journal?.work_items) || !Array.isArray(journal?.receipts)) return false;
  if (journal.work_items.some((work) => !record(work)) || journal.receipts.some((receipt) => !record(receipt))) return false;
  const workIds = journal.work_items.map((work) => work.work_id);
  const idempotencyKeys = journal.work_items.map((work) => work.idempotency_key);
  const receiptIds = journal.receipts.map((receipt) => receipt.receipt_id);
  const sequences = journal.receipts.map((receipt) => receipt.journal_sequence);
  const leaseIds = journal.receipts
    .filter(({receipt_kind: kind}) => kind === 'lease')
    .map(({lease_id: id}) => id);
  if (duplicate(workIds) || duplicate(idempotencyKeys) || duplicate(receiptIds) || duplicate(sequences) ||
      duplicate(leaseIds) || sequences.some((sequence) => sequence > journal.head_sequence)) return false;
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
  let journalObservedTick = 0;
  const activeLeases = new Map();
  for (const receipt of orderedReceipts) {
    const work = workById.get(receipt.work_id);
    const event = publicLifecycleEvent(work, receipt, orderedReceipts);
    const observedTick = event.kind === 'lease' ? event.acquiredTick : event.observedTick;
    if (Number.isInteger(observedTick)) {
      if (observedTick < journalObservedTick) return false;
      journalObservedTick = observedTick;
      for (const [leaseId, lease] of activeLeases) {
        if (lease.expiresTick <= observedTick) activeLeases.delete(leaseId);
      }
    }
    if (event.kind === 'lease') {
      if (activeLeases.size >= controlPlaneLimits.maxConcurrentWork) return false;
      activeLeases.set(event.leaseId, event);
    } else if (['retry', 'recovery', 'cancellation', 'completion'].includes(event.kind) &&
        event.leaseId !== null) {
      activeLeases.delete(event.leaseId);
    }
  }
  return journal.work_items.every((work) => {
    const workReceipts = orderedReceipts.filter((receipt) => receipt.work_id === work.work_id);
    if (!workReceiptChainIsValid(work, workReceipts, journal)) return false;
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
      verifyControlPlaneReceipt('work_enqueue', enqueueReceiptFields(enqueueReceipt), enqueueReceipt);
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
    const cancellations = work.cancellation_history;
    const completions = work.completion_history;
    if (!Array.isArray(cancellations) || !Array.isArray(completions) ||
        duplicate(cancellations.map(({receipt_id: id}) => id)) ||
        duplicate(completions.map(({receipt_id: id}) => id))) return false;
    const cancellationValid = cancellations.length === work.resume_count + (work.state === 'cancelled' ? 1 : 0) &&
      (cancellations.length === 0 ? work.cancellation === null
        : canonicalJson(work.cancellation) === canonicalJson(cancellations.at(-1))) &&
      cancellations.every((cancellation, index) => {
        const matching = journal.receipts.find((receipt) => receipt.receipt_id === cancellation.receipt_id);
        const authorization = cancellation.vault_owner_receipt;
        const applicableLease = authorization.lease_id === null ? null : journal.receipts.find((receipt) =>
          receipt.receipt_kind === 'lease' && receipt.lease_id === authorization.lease_id &&
          receipt.work_id === work.work_id && receipt.journal_sequence < cancellation.journal_sequence);
        const applicableStart = authorization.lease_id === null ? null : journal.receipts
          .filter((receipt) => receipt.receipt_kind === 'start' &&
            receipt.lease_id === authorization.lease_id && receipt.work_id === work.work_id &&
            receipt.journal_sequence < cancellation.journal_sequence)
          .at(-1);
        const leaseTimingIsValid = authorization.lease_id === null || applicableLease !== undefined &&
          applicableLease.lease_status === 'active' &&
          cancellation.cancellation_tick >= (applicableStart?.started_tick ?? applicableLease.acquired_tick) &&
          cancellation.cancellation_tick < applicableLease.expires_tick;
        return record(authorization) && cancellation.work_id === work.work_id && cancellation.idempotency_key === work.idempotency_key &&
          cancellation.work_version <= work.work_version && cancellation.journal_sequence <= journal.head_sequence &&
          cancellation.resume_count === index && cancellation.resume_count <= cancellation.resume_ceiling &&
          cancellation.resume_ceiling === journal.limits.max_resume_count &&
          cancellation.requested_by === authorization.principal_id && authorization.vault_id === journal.vault_id &&
          authorization.action_kind === 'cancel' && authorization.work_id === work.work_id &&
          authorization.work_version === cancellation.work_version - 1 &&
          authorization.idempotency_key === work.idempotency_key &&
          matching?.receipt_kind === 'cancellation' && matching.journal_sequence === cancellation.journal_sequence &&
          matching.work_id === work.work_id && matching.work_version === cancellation.work_version &&
          matching.lease_id === authorization.lease_id && matching.state === 'cancelled' &&
          leaseTimingIsValid &&
          verifyControlPlaneReceipt('vault_owner_authorization', vaultOwnerReceiptFields(authorization), authorization) &&
          verifyControlPlaneReceipt('work_journal_cancellation', cancellationReceiptFields(cancellation), cancellation);
      });
    const resumeReceipt = work.resume_receipt;
    const matchingResumeReceipt = resumeReceipt === null ? null
      : journal.receipts.find((receipt) => receipt.receipt_id === resumeReceipt.receipt_id);
    const resumeValid = work.resume_count === 0
      ? resumeReceipt === null
      : resumeReceipt !== null && work.resume_count === 1 && cancellations.length > 0 &&
        resumeReceipt.work_id === work.work_id && resumeReceipt.idempotency_key === work.idempotency_key &&
        resumeReceipt.cancelled_work_version === cancellations[0].work_version &&
        resumeReceipt.resumed_work_version === cancellations[0].work_version + 1 &&
        resumeReceipt.resumed_work_version <= work.work_version &&
        resumeReceipt.vault_owner_receipt.action_kind === 'resume' &&
        resumeReceipt.vault_owner_receipt.principal_id === 'person:owner-001' &&
        resumeReceipt.vault_owner_receipt.vault_id === journal.vault_id &&
        resumeReceipt.vault_owner_receipt.work_id === work.work_id &&
        resumeReceipt.vault_owner_receipt.work_version === resumeReceipt.cancelled_work_version &&
        resumeReceipt.vault_owner_receipt.lease_id === null &&
        resumeReceipt.vault_owner_receipt.idempotency_key === work.idempotency_key &&
        resumeReceipt.cancellation_receipt_id === cancellations[0].receipt_id &&
        resumeReceipt.cancellation_receipt_signature_digest === cancellations[0].signature_digest &&
        resumeReceipt.cancellation_completion_receipt_id === completions[0]?.receipt_id &&
        resumeReceipt.cancellation_completion_signature_digest === completions[0]?.signature_digest &&
        resumeReceipt.resume_count === cancellations[0].resume_count + 1 &&
        completions[0]?.journal_sequence === cancellations[0].journal_sequence + 1 &&
        resumeReceipt.journal_sequence === completions[0].journal_sequence + 1 &&
        resumeReceipt.journal_sequence <= journal.head_sequence &&
        matchingResumeReceipt?.receipt_kind === 'resume' &&
        matchingResumeReceipt.journal_sequence === resumeReceipt.journal_sequence &&
        matchingResumeReceipt.work_id === work.work_id &&
        matchingResumeReceipt.work_version === resumeReceipt.resumed_work_version &&
        matchingResumeReceipt.state === 'queued' &&
        verifyControlPlaneReceipt('vault_owner_authorization',
          vaultOwnerReceiptFields(resumeReceipt.vault_owner_receipt), resumeReceipt.vault_owner_receipt) &&
        verifyControlPlaneReceipt('work_resume', resumeReceiptFields(resumeReceipt), resumeReceipt);
    const completionValid = completions.every((completion) => {
      const matching = journal.receipts.find((receipt) => receipt.receipt_id === completion.receipt_id);
      const applicableLeaseReceipts = completion.lease_id === null ? []
        : journal.receipts.filter((receipt) => ['lease', 'start'].includes(receipt.receipt_kind) &&
          receipt.work_id === work.work_id && receipt.work_version <= completion.work_version &&
          receipt.journal_sequence < completion.journal_sequence);
      const matchingLease = applicableLeaseReceipts.reduce((latest, receipt) =>
        latest === null || receipt.journal_sequence > latest.journal_sequence ? receipt : latest, null);
      const cancellation = cancellations.find(({work_version: version}) => version === completion.work_version);
      const matchingLeaseReceipt = completion.lease_id === null ? null : journal.receipts.find((receipt) =>
        receipt.receipt_kind === 'lease' && receipt.lease_id === completion.lease_id &&
        receipt.work_id === work.work_id && receipt.journal_sequence < completion.journal_sequence);
      const matchingStartReceipt = completion.lease_id === null ? null : journal.receipts
        .filter((receipt) => receipt.receipt_kind === 'start' &&
          receipt.lease_id === completion.lease_id && receipt.work_id === work.work_id &&
          receipt.journal_sequence < completion.journal_sequence)
        .at(-1);
      const matchingFailedRecovery = journal.receipts.find((receipt) =>
        receipt.receipt_kind === 'recovery' && receipt.recovery_decision === 'fail' &&
        receipt.work_id === work.work_id && receipt.work_version === completion.work_version &&
        receipt.lease_id === completion.lease_id &&
        receipt.journal_sequence + 1 === completion.journal_sequence);
      const completionTimingIsValid = matchingFailedRecovery !== undefined
        ? completion.completion_tick === matchingFailedRecovery.recovery_tick
        : completion.outcome === 'cancelled'
          ? completion.completion_tick === cancellation?.cancellation_tick
          : matchingStartReceipt !== null && completion.completion_tick >= matchingStartReceipt.started_tick &&
            completion.completion_tick < matchingLeaseReceipt?.expires_tick;
      const failureTickIsWithinLease = completion.outcome !== 'failed' || (
        matchingFailedRecovery !== undefined
          ? completion.failure_observed_tick === null ||
            completion.failure_observed_tick === matchingFailedRecovery.recovery_tick
          : Number.isInteger(completion.failure_observed_tick) && matchingStartReceipt !== null &&
            completion.failure_observed_tick >= matchingStartReceipt.started_tick &&
            completion.failure_observed_tick < matchingLeaseReceipt?.expires_tick
      );
      return completion.work_id === work.work_id && completion.work_version <= work.work_version &&
        completion.idempotency_key === work.idempotency_key &&
        completion.journal_sequence <= journal.head_sequence &&
        controlPlaneOutcomeFieldsAreValid(completion, {
          retryCount: work.retry_count, retryCeiling: journal.limits.max_total_attempts - 1,
          recoveryInterruptionCount: work.recovery_interruption_count,
          recoveryCeiling: journal.limits.max_recovery_interruptions,
          retryDelays: journal.limits.retry_delays_ms,
          latestDispatchTick: controlPlaneLimits.latestDispatchTick,
        }) && completionTimingIsValid && failureTickIsWithinLease && matching?.receipt_kind === 'completion' &&
        matching.journal_sequence === completion.journal_sequence &&
        matching.work_id === work.work_id && matching.work_version === completion.work_version &&
        matching.lease_id === completion.lease_id && matching.state === completion.outcome &&
        (completion.outcome !== 'cancelled' || completion.journal_sequence === cancellation?.journal_sequence + 1) &&
        (completion.outcome === 'cancelled'
          ? completion.lease_id === cancellation?.vault_owner_receipt.lease_id &&
            (completion.lease_id === null || matchingLease?.lease_id === completion.lease_id)
          : typeof completion.lease_id === 'string' && matchingLease?.lease_id === completion.lease_id) &&
        verifyControlPlaneReceipt('work_completion', completionReceiptFields(completion), completion);
    });
    const cancellationCompletionsValid = cancellations.every((cancellation) =>
      completions.some((completion) => completion.work_version === cancellation.work_version &&
        completion.outcome === 'cancelled' && completion.journal_sequence === cancellation.journal_sequence + 1));
    const completionInventoryValid = completions.length === cancellations.length +
      (terminal && work.state !== 'cancelled' ? 1 : 0);
    const resultValid = terminal
      ? result !== null && result.outcome === work.state && result.work_version === work.work_version &&
        canonicalJson(completions.at(-1)) === canonicalJson(result)
      : result === null;
    const lifecycleReceiptIds = journal.receipts
      .filter((receipt) => receipt.work_id === work.work_id &&
        ['enqueue', 'cancellation', 'resume', 'completion'].includes(receipt.receipt_kind))
      .map(({receipt_id: id}) => id).sort();
    const embeddedReceiptIds = [enqueueReceipt.receipt_id, ...cancellations.map(({receipt_id: id}) => id),
      ...(resumeReceipt === null ? [] : [resumeReceipt.receipt_id]),
      ...completions.map(({receipt_id: id}) => id)].sort();
    const lifecycleRecordsExact = sameOrder(lifecycleReceiptIds, embeddedReceiptIds);
    const recoveryCountValid = work.recovery_interruption_count <= journal.limits.max_recovery_interruptions ||
      work.recovery_interruption_count === journal.limits.max_recovery_interruptions + 1 &&
        work.state === 'failed' && result?.code === 'control.recovery_ceiling_exceeded';
    return enqueueValid && leaseValid && retryValid && cancellationValid && resumeValid && completionValid &&
      cancellationCompletionsValid && completionInventoryValid && resultValid && lifecycleRecordsExact &&
      recoveryCountValid;
  });
}

function lifecycleObservationTick(work, receipts) {
  const cancellationTicks = new Map(work.cancellation_history
    .map((receipt) => [receipt.receipt_id, receipt.cancellation_tick]));
  const completionTicks = new Map(work.completion_history
    .map((receipt) => [receipt.receipt_id, receipt.completion_tick]));
  return receipts.reduce((latest, receipt) => Math.max(latest,
    receipt.receipt_kind === 'lease' ? receipt.acquired_tick
      : receipt.receipt_kind === 'start' ? receipt.started_tick
        : receipt.receipt_kind === 'retry' ? receipt.failure_observed_tick
          : receipt.receipt_kind === 'recovery' ? receipt.recovery_tick
            : receipt.receipt_kind === 'cancellation' ? cancellationTicks.get(receipt.receipt_id) ?? latest
              : receipt.receipt_kind === 'completion' ? completionTicks.get(receipt.receipt_id) ?? latest
                : latest), 0);
}

function schedulerStateValid(scheduler, journal, agent) {
  if (!Array.isArray(scheduler?.eligible_queue) || !Array.isArray(scheduler?.active_leases)) return false;
  if (scheduler.eligible_queue.some((entry) => !record(entry)) || scheduler.active_leases.some((lease) => !record(lease))) return false;
  const queuedIds = scheduler.eligible_queue.map((entry) => entry.work_id);
  const leasedIds = scheduler.active_leases.map((lease) => lease.lease_id);
  const leasedWorkIds = scheduler.active_leases.map((lease) => lease.work_id);
  const journalWork = Array.isArray(journal?.work_items) ? journal.work_items : [];
  const observationIsCurrent = journalWork.every((work) => scheduler.observation_tick >=
    lifecycleObservationTick(work, journal.receipts.filter((receipt) => receipt.work_id === work.work_id)));
  const expectedQueuedWork = journalWork.filter(({state}) => ['queued', 'retry_wait'].includes(state));
  const expectedActiveWork = journalWork.filter(({state, lease}) =>
    ['leased', 'executing'].includes(state) && lease?.status === 'active' &&
    lease.acquired_tick <= scheduler.observation_tick && scheduler.observation_tick < lease.expires_tick);
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
    Number.isInteger(scheduler.observation_tick) &&
    observationIsCurrent &&
    !duplicate(queuedIds) && !duplicate(leasedIds) && !duplicate(leasedWorkIds) &&
    scheduler.active_leases.length <= scheduler.limits.max_concurrent_work &&
    queueMatchesJournal && leasesMatchJournal && queuedIds.every((id) => !leasedWorkIds.includes(id)) &&
    scheduler.active_leases.every((lease) =>
      lease.status === 'active' && lease.expires_tick > lease.acquired_tick &&
      lease.acquired_tick <= scheduler.observation_tick && scheduler.observation_tick < lease.expires_tick &&
      lease.expires_tick - lease.acquired_tick <= scheduler.limits.lease_duration_ticks);
}

function agentStateValid(agent) {
  const gateNames = ['exclusive_writer', 'vault_filesystem', 'semantic_kernel', 'compatibility', 'derived_views', 'work_journal'];
  if (!Array.isArray(agent?.readiness_gates) || agent.readiness_gates.length !== gateNames.length ||
      agent.readiness_gates.some((gate, index) => !record(gate) || gate.ordinal !== index + 1 || gate.gate !== gateNames[index])) return false;
  if (agent.supervision_profile !== 'contracts/control-plane/launchagent-supervision-profile.json' ||
      !record(agent.supervision_state) || !record(agent.supervision_state.circuit) ||
      agent.supervision_state.automatic_restart_attempt_count > 3 ||
      agent.supervision_state.circuit.storage !== 'durable_agent_state' ||
      agent.supervision_state.circuit.trip_threshold !== 3 || !record(agent.wake_revalidation)) return false;
  if (agent.state !== 'ready') return true;
  const writer = agent.writer_lock;
  if (writer?.owner_agent_id !== agent.persistent_agent_id || writer.epoch <= 0 || writer.prior_epoch !== writer.epoch - 1 ||
      writer.retained !== true || typeof writer.token_digest !== 'string' ||
      !verifyControlPlaneReceipt(
        'writer_lock', writerLockReceiptFields(writer, agent.vault_id), writer, agent.persistent_agent_id,
      )) return false;
  let previousReceiptDigest = writer.signature_digest;
  const gatesValid = agent.readiness_gates.every((gate) => {
    const valid = gate.verdict === 'pass' && gate.agent_id === agent.persistent_agent_id && gate.vault_id === agent.vault_id &&
      gate.previous_receipt_digest === previousReceiptDigest && verifyControlPlaneReceipt(
        'readiness_gate', readinessGateReceiptFields(gate), gate, agent.persistent_agent_id,
      );
    previousReceiptDigest = gate.signature_digest;
    return valid;
  });
  return writer.owner_agent_id === agent.persistent_agent_id && writer.epoch > 0 &&
    agent.writer_lock.retained === true && typeof agent.writer_lock.token_digest === 'string' &&
    agent.control_channel_state === 'work_admitting' && gatesValid &&
    agent.supervision_state.state === 'supervised' && agent.supervision_state.automatic_restart_attempt_count === 0 &&
    agent.supervision_state.next_restart_tick === null && agent.supervision_state.circuit.state === 'closed' &&
    agent.wake_revalidation.verdict === 'pass' && agent.doctor_report === null &&
    agent.owner_recovery_authorization === null;
}

function controlCommandStateValid(command, journal) {
  const peer = command?.peer;
  if (peer?.peer_credentials_verified !== true || peer.local_transport !== true ||
      peer.peer_uid !== peer.effective_uid || peer.vault_scope !== command.vault_id ||
      command.vault_id !== journal?.vault_id || command.command_version !== 1 ||
      command.payload_digest !== canonicalDigest({
        command_kind: command.command_kind,
        command_version: command.command_version,
        idempotency_key: command.idempotency_key,
        payload: command.payload,
        base_references: command.base_references,
      })) return false;
  const expectedBaseKind = ['cancel', 'resume'].includes(command.command_kind) ? 'work_item'
    : command.command_kind === 'enqueue' ? 'work_journal' : null;
  if (expectedBaseKind === null) return true;
  if (!Array.isArray(command.base_references)) return false;
  const matchingBases = command.base_references.filter((base) => record(base) && base.kind === expectedBaseKind);
  if (command.base_references.length !== 1 || matchingBases.length !== 1) return false;
  const base = matchingBases[0];
  if (expectedBaseKind === 'work_journal') {
    const replayWork = journal?.work_items?.find(({idempotency_key: key}) => key === command.idempotency_key);
    const collidingWork = journal?.work_items?.find(({work_id: id}) => id === command.payload.work_id);
    if (replayWork === undefined && collidingWork !== undefined) return false;
    const expectedSequence = replayWork?.enqueue_receipt?.base_head_sequence ?? journal?.head_sequence;
    const expectedDigest = replayWork?.enqueue_receipt?.base_head_digest ?? journal?.head_digest;
    const payloadMatchesReplay = replayWork === undefined ||
      command.payload.work_id === replayWork.work_id && command.payload.work_kind === replayWork.work_kind &&
      command.payload.input_digest === replayWork.input_digest &&
      canonicalJson(command.payload.dependencies) === canonicalJson(replayWork.dependencies) &&
      canonicalJson(command.payload.budget) === canonicalJson(replayWork.budget);
    return payloadMatchesReplay && base.reference_id === journal?.journal_id &&
      base.version === expectedSequence && base.digest === expectedDigest;
  }
  const work = journal?.work_items?.find(({work_id: id}) => id === base.reference_id);
  const applicableLease = ['leased', 'executing'].includes(work?.state) ? work.lease?.lease_id ?? null : null;
  const expectedLease = command.command_kind === 'resume' ? null : applicableLease;
  return work !== undefined && command.payload.work_id === work.work_id &&
    command.idempotency_key === work.idempotency_key &&
    command.payload.expected_work_version === work.work_version && command.payload.lease_id === expectedLease &&
    (command.command_kind !== 'resume' || work.state === 'cancelled') &&
    base.version === work.work_version && base.digest === canonicalDigest(work);
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
