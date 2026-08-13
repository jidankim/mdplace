import {signControlPlaneReceipt, verifyControlPlaneReceipt} from './control-plane-authentication.mjs';
import {schemaErrorCode, validateAgainstSchemaPath} from './json-schema.mjs';

const authorityByAction = new Map([
  ['enqueue', 'work_submitter'],
  ['dispatch', 'scheduler'],
  ['acknowledge', 'mdplace_agent'],
  ['fail', 'mdplace_agent'],
  ['retry', 'scheduler'],
  ['cancel', 'vault_owner'],
  ['resume', 'vault_owner'],
  ['restart', 'launchd_supervisor'],
  ['recover', 'mdplace_agent'],
  ['readiness_check', 'mdplace_agent'],
  ['control_command', 'control_client'],
  ['acquire_writer', 'mdplace_agent'],
]);

const readinessGateNames = [
  'exclusive_writer', 'vault_filesystem', 'semantic_kernel', 'compatibility',
  'derived_views', 'work_journal', 'control_channel',
];

function completionFields(receipt) {
  return [
    receipt.receipt_id, receipt.work_id, receipt.work_version, receipt.lease_id ?? '',
    receipt.journal_sequence, receipt.outcome, receipt.output_digest ?? '',
  ];
}

function completionReceiptFor(initial, work, outcome, outputDigest = null, leaseId = work.lease_id) {
  const receipt = {
    receipt_id: `receipt:${outcome}-${work.work_id.slice(5)}`,
    work_id: work.work_id,
    work_version: work.work_version,
    lease_id: leaseId,
    journal_sequence: initial.journal_head_sequence + 1,
    outcome,
    output_digest: outputDigest,
  };
  return {...receipt, ...signControlPlaneReceipt('work_completion', completionFields(receipt))};
}

function validCompletionReceipt(initial, work) {
  const receipt = work?.completion_receipt;
  const outputIsValid = work?.state === 'succeeded'
    ? typeof receipt?.output_digest === 'string' && /^[a-f0-9]{64}$/.test(receipt.output_digest)
    : receipt?.output_digest === null;
  return receipt !== null && receipt !== undefined &&
    receipt.work_id === work.work_id && receipt.work_version === work.work_version &&
    receipt.journal_sequence <= initial.journal_head_sequence &&
    receipt.outcome === work.state && outputIsValid && receipt.signer_agent_id === initial.persistent_agent_id &&
    verifyControlPlaneReceipt('work_completion', completionFields(receipt), receipt, initial.persistent_agent_id);
}

function writerReceiptIsCurrent(initial, action) {
  const receipt = action.writer_lock_receipt;
  return receipt !== null && receipt.prior_epoch === initial.writer_epoch &&
    receipt.epoch === initial.writer_epoch + 1 && receipt.owner_agent_id === initial.persistent_agent_id &&
    receipt.retained === true && action.expected_writer_epoch === initial.writer_epoch &&
    verifyControlPlaneReceipt('writer_lock', [
      receipt.lock_id, receipt.prior_epoch, receipt.epoch, receipt.owner_agent_id,
      receipt.token_digest, receipt.retained, initial.control_channel.vault_id,
    ], receipt, initial.persistent_agent_id);
}

function writerReceiptIsRetained(initial, action) {
  const receipt = action.writer_lock_receipt;
  return receipt !== null && initial.writer_epoch > 0 && receipt.prior_epoch === initial.writer_epoch - 1 &&
    receipt.epoch === initial.writer_epoch && receipt.owner_agent_id === initial.persistent_agent_id &&
    receipt.retained === true && action.expected_writer_epoch === initial.writer_epoch &&
    verifyControlPlaneReceipt('writer_lock', [
      receipt.lock_id, receipt.prior_epoch, receipt.epoch, receipt.owner_agent_id,
      receipt.token_digest, receipt.retained, initial.control_channel.vault_id,
    ], receipt, initial.persistent_agent_id);
}

function readinessObservationsAreExact(initial, action, failedGate = null) {
  const observations = action.readiness_observations;
  if (!Array.isArray(observations) || observations.length !== readinessGateNames.length) return false;
  const failedIndex = failedGate === null ? -1 : readinessGateNames.indexOf(failedGate);
  let previousReceiptDigest = action.writer_lock_receipt?.signature_digest ?? initial.semantic_state_digest;
  return observations.every((observation, index) => {
    const expectedVerdict = failedIndex < 0 ? 'pass' : index < failedIndex ? 'pass' : index === failedIndex ? 'fail' : 'not_run';
    const expectedReceipt = expectedVerdict === 'not_run' ? null : `readiness-receipt:${String(index + 1).padStart(3, '0')}`;
    if (observation.ordinal !== index + 1 || observation.gate !== readinessGateNames[index] ||
        observation.verdict !== expectedVerdict || observation.receipt_id !== expectedReceipt) return false;
    if (expectedVerdict === 'not_run') {
      return observation.agent_id === null && observation.vault_id === null && observation.observation_digest === null &&
        observation.previous_receipt_digest === null && observation.signature_scheme === null &&
        observation.signing_key_id === null && observation.signer_agent_id === null &&
        observation.signature_digest === null && observation.authenticated === false;
    }
    const valid = observation.agent_id === initial.persistent_agent_id &&
      observation.vault_id === initial.control_channel.vault_id &&
      observation.previous_receipt_digest === previousReceiptDigest &&
      verifyControlPlaneReceipt('readiness_gate', [
        observation.receipt_id, observation.agent_id, observation.vault_id, observation.ordinal,
        observation.gate, observation.verdict, observation.observation_digest,
        observation.previous_receipt_digest,
      ], observation, initial.persistent_agent_id);
    previousReceiptDigest = observation.signature_digest;
    return valid;
  });
}

function observed(initial, action, {
  verdict = 'pass', codes = [], outputs, operations, receipts,
  effects = ['none'], terminal, illegal = false, work = initial.work,
}) {
  if (verdict === 'pass' && !workStateIsConsistent(work)) {
    return {
      verdict: 'fail', codes: ['control.post_state_invalid'],
      outputs: ['control-plane mutation rejected', `work_state:${initial.work?.state ?? 'none'}`,
        `semantic_state_digest:${initial.semantic_state_digest}`],
      operations: ['validate constructed Work Item state'],
      receipts: ['ControlPlaneRejectionReceipt:control.post_state_invalid'],
      filesystem_effects: ['none'], terminal_state: 'rejected', illegal_transition: false,
    };
  }
  const completeOutputs = [...outputs, `work_state:${work?.state ?? 'none'}`];
  const completeOperations = [...operations];
  if (action.semantic_write_requested) {
    completeOutputs.push(`semantic_write:denied:${action.authority_source}`);
    completeOperations.push('deny control-plane semantic write');
  }
  completeOutputs.push(`semantic_state_digest:${initial.semantic_state_digest}`);
  return {
    verdict, codes, outputs: completeOutputs, operations: completeOperations, receipts,
    filesystem_effects: effects, terminal_state: terminal, illegal_transition: illegal,
  };
}

function rejected(initial, action, code, {illegal = false, terminal = 'rejected'} = {}) {
  return observed(initial, action, {
    verdict: 'fail', codes: [code], outputs: [`${action.kind} rejected`],
    operations: ['validate control-plane command and exact bases'],
    receipts: [`ControlPlaneRejectionReceipt:${code}`], terminal, illegal,
  });
}

function exactWorkBase(initial, action) {
  return initial.work !== null && action.work_id === initial.work.work_id &&
    action.expected_work_version === initial.work.work_version;
}

function workStateIsConsistent(work) {
  if (work === null) return true;
  const scalarBoundsAreValid = Number.isInteger(work.work_version) && work.work_version >= 1 && work.work_version <= 1000000 &&
    Number.isInteger(work.retry_count) && work.retry_count >= 0 && work.retry_count <= work.retry_ceiling &&
    Number.isInteger(work.recovery_interruption_count) && work.recovery_interruption_count >= 0 && work.recovery_interruption_count <= 2 &&
    Number.isInteger(work.resume_count) && work.resume_count >= 0 && work.resume_count <= work.resume_ceiling;
  const leased = work.state === 'leased' || work.state === 'executing';
  const leaseIsBound = typeof work.lease_id === 'string' && typeof work.owner_agent_id === 'string' &&
    ['active', 'revoked', 'expired'].includes(work.lease_status) &&
    Number.isInteger(work.lease_acquired_tick) && Number.isInteger(work.lease_expires_tick) &&
    work.lease_acquired_tick >= 0 && work.lease_acquired_tick <= 1000000 &&
    work.lease_expires_tick > work.lease_acquired_tick && work.lease_expires_tick <= 1000300 &&
    work.lease_expires_tick - work.lease_acquired_tick <= 300;
  const leaseIsAbsent = work.lease_id === null && work.owner_agent_id === null && work.lease_status === null &&
    work.lease_acquired_tick === null && work.lease_expires_tick === null;
  const retryEligibilityIsValid = work.state === 'retry_wait'
    ? Number.isInteger(work.retry_eligible_tick) && work.retry_eligible_tick >= 0 && work.retry_eligible_tick <= 1000000
    : work.retry_eligible_tick === null;
  const terminal = ['cancelled', 'succeeded', 'failed'].includes(work.state);
  const completionIsValid = terminal ? work.completion_receipt !== null : work.completion_receipt === null;
  return scalarBoundsAreValid && (leased ? leaseIsBound : leaseIsAbsent) && retryEligibilityIsValid && completionIsValid &&
    (!terminal || work.completion_receipt.outcome === work.state);
}

function enqueue(initial, action) {
  if (!initial.journal_available) return rejected(initial, action, 'control.journal_unavailable', {terminal: 'blocked'});
  if (initial.work !== null) {
    const compatible = action.work_id === initial.work.work_id &&
      action.idempotency_key === initial.work.idempotency_key &&
      action.proposed_work_input_digest === initial.work.input_digest;
    if (!compatible) return rejected(initial, action, 'control.idempotency_incompatible');
    return observed(initial, action, {
      outputs: ['enqueue idempotent'], operations: ['read Work Journal', 'resolve idempotency binding'],
      receipts: [`EnqueueReceipt:${initial.work.work_id}`], terminal: initial.work.state,
    });
  }
  if (action.work_id === null || action.idempotency_key === null || action.proposed_work_input_digest === null) {
    return rejected(initial, action, 'control.enqueue_binding_missing');
  }
  const work = {
    work_id: action.work_id, work_version: 1, state: 'queued', idempotency_key: action.idempotency_key,
    input_digest: action.proposed_work_input_digest, retry_count: 0, retry_ceiling: 2,
    retry_eligible_tick: null, recovery_interruption_count: 0,
    lease_id: null, lease_status: null, lease_acquired_tick: null, lease_expires_tick: null,
    owner_agent_id: null, cancellation_id: null, resume_count: 0, resume_ceiling: 1,
    completion_receipt: null,
  };
  return observed(initial, action, {
    outputs: [action.interruption_count > 0 ? 'enqueue recovered after process loss' : 'enqueue accepted'],
    operations: ['validate Work Journal availability', 'resolve idempotency binding', 'append enqueue record', 'read committed enqueue after interruption'],
    receipts: [`EnqueueReceipt:${work.work_id}`], effects: ['append durable Work Journal record'],
    terminal: 'queued', work,
  });
}

function dispatch(initial, action) {
  if (initial.agent_state !== 'ready' || initial.writer_owner_agent_id !== initial.persistent_agent_id) {
    return rejected(initial, action, 'control.agent_not_ready', {terminal: 'blocked'});
  }
  if (initial.work?.state === 'leased' || initial.work?.state === 'executing') {
    return rejected(initial, action, 'control.owner_conflict', {terminal: initial.work.state});
  }
  if (action.expected_journal_head_sequence !== initial.journal_head_sequence) {
    return rejected(initial, action, 'control.journal_head_stale', {terminal: 'blocked'});
  }
  if (!writerReceiptIsRetained(initial, action)) {
    return rejected(initial, action, 'control.writer_receipt_invalid', {terminal: 'blocked'});
  }
  if (!readinessObservationsAreExact(initial, action)) {
    return rejected(initial, action, 'control.readiness_sequence_invalid', {terminal: 'blocked'});
  }
  if (action.expected_dependency_state_digest !== initial.dependency_state_digest) {
    return rejected(initial, action, 'control.dependency_base_stale', {terminal: 'blocked'});
  }
  if (initial.active_work_count >= initial.max_concurrent_work) {
    return rejected(initial, action, 'control.concurrency_budget_exhausted', {terminal: 'blocked'});
  }
  if (!exactWorkBase(initial, action)) return rejected(initial, action, 'control.work_version_stale');
  if (!['queued', 'retry_wait'].includes(initial.work.state) || action.lease_id === null) {
    return rejected(initial, action, 'control.illegal_transition', {illegal: true, terminal: initial.work.state});
  }
  if (!Number.isInteger(action.current_tick)) return rejected(initial, action, 'control.current_tick_missing', {terminal: 'blocked'});
  if (initial.work.state === 'retry_wait' && action.current_tick < initial.work.retry_eligible_tick) {
    return rejected(initial, action, 'control.retry_not_eligible', {terminal: 'retry_wait'});
  }
  const acquiredTick = action.current_tick;
  const work = {...initial.work, work_version: initial.work.work_version + 1, state: 'leased',
    retry_eligible_tick: null, lease_id: action.lease_id, lease_status: 'active',
    lease_acquired_tick: acquiredTick, lease_expires_tick: acquiredTick + 300,
    owner_agent_id: initial.persistent_agent_id};
  return observed(initial, action, {
    outputs: ['dispatch accepted', 'dequeue acknowledged after receipt'],
    operations: ['validate Agent readiness', 'compare Work Item version', 'publish Work Lease receipt', 'acknowledge dequeue'],
    receipts: [`WorkLeaseReceipt:${action.lease_id}`], effects: ['append durable Work Lease record'], terminal: 'leased', work,
  });
}

function acknowledge(initial, action) {
  if (!exactWorkBase(initial, action)) return rejected(initial, action, 'control.work_version_stale');
  if (initial.work.state !== 'leased' || initial.work.lease_status !== 'active' || action.lease_id !== initial.work.lease_id) {
    return rejected(initial, action, 'control.lease_stale', {terminal: initial.work.state});
  }
  if (!Number.isInteger(action.current_tick) || action.current_tick >= initial.work.lease_expires_tick) {
    return rejected(initial, action, 'control.lease_stale', {terminal: initial.work.state});
  }
  const work = {...initial.work, work_version: initial.work.work_version + 1, state: 'executing'};
  return observed(initial, action, {
    outputs: ['execution acknowledged'], operations: ['compare Work Lease', 'append execution receipt'],
    receipts: [`ExecutionReceipt:${work.work_id}`], effects: ['append durable execution record'], terminal: 'executing', work,
  });
}

function fail(initial, action) {
  if (!exactWorkBase(initial, action)) return rejected(initial, action, 'control.work_version_stale');
  if (initial.work.state !== 'executing' || action.lease_id !== initial.work.lease_id ||
      initial.work.lease_status !== 'active' || !Number.isInteger(action.current_tick) ||
      action.current_tick >= initial.work.lease_expires_tick) {
    return rejected(initial, action, 'control.lease_stale', {terminal: initial.work.state});
  }
  if (action.retryable && initial.work.retry_count < initial.work.retry_ceiling) {
    const nextRetryCount = initial.work.retry_count + 1;
    const retryDelay = nextRetryCount === 1 ? 1000 : 5000;
    const retryEligibleTick = action.current_tick + retryDelay;
    if (retryEligibleTick <= 1000000) {
      const work = {...initial.work, work_version: initial.work.work_version + 1, state: 'retry_wait',
        retry_count: nextRetryCount, retry_eligible_tick: retryEligibleTick,
        lease_id: null, lease_status: null, lease_acquired_tick: null, lease_expires_tick: null,
        owner_agent_id: null};
      return observed(initial, action, {
        outputs: ['retry recorded', `retry_delay_ms:${retryDelay}`],
        operations: ['validate failure receipt', 'consume retry budget', 'append retry record'],
        receipts: [`RetryReceipt:${work.work_id}:${work.retry_count}`], effects: ['append durable retry record'], terminal: 'retry_wait', work,
      });
    }
  }
  const work = {...initial.work, work_version: initial.work.work_version + 1, state: 'failed',
    retry_eligible_tick: null, lease_id: null, lease_status: null, lease_acquired_tick: null,
    lease_expires_tick: null, owner_agent_id: null};
  work.completion_receipt = completionReceiptFor(initial, work, 'failed', null, initial.work.lease_id);
  return observed(initial, action, {
    outputs: [action.retryable && initial.work.retry_count < initial.work.retry_ceiling
      ? 'retry eligibility tick overflow produced terminal failure'
      : 'retry ceiling produced terminal failure'],
    operations: ['validate failure receipt', 'compare retry ceiling', 'append terminal failure'],
    receipts: [`TerminalFailureReceipt:${work.work_id}`], effects: ['append durable terminal failure'], terminal: 'failed', work,
  });
}

function retry(initial, action) {
  if (initial.work?.state === 'failed' || initial.work?.retry_count > initial.work?.retry_ceiling) {
    return rejected(initial, action, 'control.retry_ceiling_exceeded', {illegal: true, terminal: initial.work?.state ?? 'rejected'});
  }
  if (!exactWorkBase(initial, action) || initial.work.state !== 'retry_wait') {
    return rejected(initial, action, 'control.illegal_transition', {illegal: true, terminal: initial.work?.state ?? 'rejected'});
  }
  if (!Number.isInteger(action.current_tick) || action.current_tick < initial.work.retry_eligible_tick) {
    return rejected(initial, action, 'control.retry_not_eligible', {terminal: 'retry_wait'});
  }
  return dispatch(initial, {...action, kind: 'dispatch'});
}

function cancel(initial, action) {
  if (!exactWorkBase(initial, action)) return rejected(initial, action, 'control.work_version_stale');
  if (initial.work.state === 'cancelled') {
    return observed(initial, action, {
      outputs: ['cancellation idempotent'], operations: ['compare Work Item version', 'return original cancellation receipt'],
      receipts: [`CancellationReceipt:${initial.work.cancellation_id}`], terminal: 'cancelled',
    });
  }
  if (!['queued', 'leased', 'executing', 'retry_wait'].includes(initial.work.state)) {
    return rejected(initial, action, 'control.illegal_transition', {illegal: true, terminal: initial.work.state});
  }
  const wasExecuting = initial.work.state === 'executing';
  const work = {...initial.work, work_version: initial.work.work_version + 1, state: 'cancelled',
    retry_eligible_tick: null, lease_id: null, lease_status: null, lease_acquired_tick: null,
    lease_expires_tick: null, owner_agent_id: null, cancellation_id: `cancel:${initial.work.work_id.slice(5)}`};
  work.completion_receipt = completionReceiptFor(initial, {...work, lease_id: initial.work.lease_id}, 'cancelled');
  return observed(initial, action, {
    outputs: [wasExecuting ? 'in-flight cancellation durable' : 'queued cancellation durable'],
    operations: ['compare Work Item version', 'append cancellation record', ...(wasExecuting ? ['revoke Child Work Invocation'] : [])],
    receipts: [`CancellationReceipt:${work.cancellation_id}`], effects: ['append durable cancellation record', ...(wasExecuting ? ['terminate Child Work Invocation capability'] : [])],
    terminal: 'cancelled', work,
  });
}

function resume(initial, action) {
  if (!exactWorkBase(initial, action)) return rejected(initial, action, 'control.work_version_stale');
  if (initial.work.state !== 'cancelled' || initial.work.resume_count >= initial.work.resume_ceiling) {
    return rejected(initial, action, 'control.resume_budget_exhausted', {illegal: true, terminal: initial.work.state});
  }
  const work = {...initial.work, work_version: initial.work.work_version + 1, state: 'queued',
    cancellation_id: null, resume_count: initial.work.resume_count + 1, completion_receipt: null};
  return observed(initial, action, {
    outputs: ['cancelled work resumed within bound'],
    operations: ['authenticate vault owner', 'compare cancelled Work Item version', 'consume resume budget', 'append resume record'],
    receipts: [`ResumeReceipt:${work.work_id}:${work.resume_count}`], effects: ['append durable resume record'], terminal: 'queued', work,
  });
}

function restart(initial, action) {
  if (!initial.journal_available || !initial.semantic_dependency_available) return rejected(initial, action, 'control.readiness_dependency_unavailable', {terminal: 'blocked'});
  if (initial.writer_owner_agent_id !== null) return rejected(initial, action, 'control.writer_owner_conflict', {terminal: 'blocked'});
  if (action.expected_journal_head_sequence !== initial.journal_head_sequence) return rejected(initial, action, 'control.journal_head_stale', {terminal: 'blocked'});
  if (!writerReceiptIsCurrent(initial, action)) return rejected(initial, action, 'control.writer_receipt_invalid', {terminal: 'blocked'});
  if (!readinessObservationsAreExact(initial, action)) return rejected(initial, action, 'control.readiness_sequence_invalid', {terminal: 'blocked'});
  if (['succeeded', 'failed', 'cancelled'].includes(initial.work?.state) && !validCompletionReceipt(initial, initial.work)) {
    return rejected(initial, action, 'control.completion_receipt_invalid', {terminal: 'blocked'});
  }
  const outputs = initial.work?.state === 'cancelled' ? ['cancelled work preserved after restart']
    : initial.work?.state === 'queued' ? ['queued work available after Agent restart']
      : initial.work?.state === 'succeeded' ? ['completed work not repeated after restart'] : ['Agent restart reconciled'];
  return observed(initial, action, {
    outputs,
    operations: ['acquire Exclusive Writer Lock', 'validate vault and filesystem profile', 'validate Semantic Kernel', 'validate compatibility', 'rebuild disposable views', 'reconcile Work Journal', 'open Control Channel'],
    receipts: [`AgentRestartReceipt:${initial.persistent_agent_id}`], terminal: 'ready',
  });
}

function recover(initial, action) {
  if (!initial.journal_available) return rejected(initial, action, 'control.journal_unavailable', {terminal: 'blocked'});
  if (!initial.semantic_dependency_available) return rejected(initial, action, 'control.semantic_dependency_unavailable', {terminal: 'blocked'});
  if (initial.writer_owner_agent_id !== null) return rejected(initial, action, 'control.writer_owner_conflict', {terminal: 'blocked'});
  if (action.expected_journal_head_sequence !== initial.journal_head_sequence) return rejected(initial, action, 'control.journal_head_stale', {terminal: 'blocked'});
  if (!writerReceiptIsCurrent(initial, action)) return rejected(initial, action, 'control.writer_receipt_invalid', {terminal: 'blocked'});
  if (!readinessObservationsAreExact(initial, action)) return rejected(initial, action, 'control.readiness_sequence_invalid', {terminal: 'blocked'});
  if (initial.work === null || !exactWorkBase(initial, action)) return rejected(initial, action, 'control.work_version_stale');
  if (['succeeded', 'failed', 'cancelled'].includes(initial.work.state)) {
    if (!validCompletionReceipt(initial, initial.work)) return rejected(initial, action, 'control.completion_receipt_invalid', {terminal: 'blocked'});
    return observed(initial, action, {
      outputs: ['terminal completion preserved without repeat'], operations: ['read completion receipt', 'preserve terminal Work Item'],
      receipts: [`WorkRecoveryReceipt:${initial.work.work_id}`], terminal: initial.work.state,
    });
  }
  if (!['leased', 'executing'].includes(initial.work.state)) return rejected(initial, action, 'control.recovery_not_required', {illegal: true, terminal: initial.work.state});
  if (action.lease_id !== initial.work.lease_id || !['expired', 'revoked'].includes(initial.work.lease_status) ||
      action.recovery_tick === null || (initial.work.lease_status === 'expired' && action.recovery_tick < initial.work.lease_expires_tick)) {
    return rejected(initial, action, 'control.lease_not_recoverable', {terminal: 'blocked'});
  }
  if (action.interruption_count !== initial.work.recovery_interruption_count + 1) {
    return rejected(initial, action, 'control.recovery_count_invalid', {terminal: 'blocked'});
  }
  const recoveryExhausted = action.interruption_count > 2;
  const retryExhausted = initial.work.state === 'executing' && initial.work.retry_count >= initial.work.retry_ceiling;
  const nextRecoveryRetryCount = initial.work.retry_count + 1;
  const recoveryRetryDelay = nextRecoveryRetryCount === 1 ? 1000 : 5000;
  const retryTickOverflow = initial.work.state === 'executing' && action.recovery_tick + recoveryRetryDelay > 1000000;
  if (recoveryExhausted || retryExhausted || retryTickOverflow) {
    const work = {...initial.work, work_version: initial.work.work_version + 1, state: 'failed',
      retry_eligible_tick: null, recovery_interruption_count: Math.min(action.interruption_count, 2),
      lease_id: null, lease_status: null, lease_acquired_tick: null, lease_expires_tick: null,
      owner_agent_id: null};
    work.completion_receipt = completionReceiptFor(initial, work, 'failed', null, initial.work.lease_id);
    return observed(initial, action, {
      outputs: [recoveryExhausted ? 'recovery interruption ceiling produced terminal failure'
        : retryExhausted ? 'retry ceiling produced terminal failure'
          : 'retry eligibility tick overflow produced terminal failure'],
      operations: ['read Work Journal recovery bases', 'compare recovery and retry ceilings', 'append authenticated terminal failure'],
      receipts: [`TerminalFailureReceipt:${work.work_id}`], effects: ['append durable terminal failure'], terminal: 'failed', work,
    });
  }
  const nextState = initial.work.state === 'executing' ? 'retry_wait' : 'queued';
  const nextRetryCount = initial.work.state === 'executing' ? initial.work.retry_count + 1 : initial.work.retry_count;
  const retryDelay = nextRetryCount === 1 ? 1000 : 5000;
  const work = {...initial.work, work_version: initial.work.work_version + 1, state: nextState,
    retry_count: nextRetryCount,
    retry_eligible_tick: initial.work.state === 'executing' ? action.recovery_tick + retryDelay : null,
    recovery_interruption_count: action.interruption_count,
    lease_id: null, lease_status: null, lease_acquired_tick: null, lease_expires_tick: null,
    owner_agent_id: null};
  return observed(initial, action, {
    outputs: [initial.work.state === 'executing' ? 'in-flight work recovered without duplicate' : 'leased work remains recoverable'],
    operations: ['read Work Journal recovery bases', 'compare Work Lease and receipts', 'consume recovery interruption budget', 'append Work Recovery receipt'],
    receipts: [`WorkRecoveryReceipt:${work.work_id}:${action.interruption_count}`], effects: ['append durable Work Recovery record'], terminal: nextState, work,
  });
}

function readinessCheck(initial, action) {
  if (!['starting', 'blocked'].includes(initial.agent_state)) {
    return rejected(initial, action, 'control.illegal_transition', {illegal: true, terminal: initial.agent_state});
  }
  const unavailable = initial.writer_owner_agent_id !== initial.persistent_agent_id ? 'control.readiness_writer_absent'
    : !initial.semantic_dependency_available ? 'control.readiness_semantic_dependency_unavailable'
      : !initial.journal_available ? 'control.readiness_journal_unavailable' : null;
  const failedGate = unavailable === 'control.readiness_writer_absent' ? 'exclusive_writer'
    : unavailable === 'control.readiness_semantic_dependency_unavailable' ? 'semantic_kernel'
      : unavailable === 'control.readiness_journal_unavailable' ? 'work_journal' : null;
  if (!readinessObservationsAreExact(initial, action, failedGate)) {
    return rejected(initial, action, 'control.readiness_sequence_invalid', {terminal: 'blocked'});
  }
  if (unavailable !== null) return rejected(initial, action, unavailable, {terminal: 'blocked'});
  return observed(initial, action, {
    outputs: ['Readiness Gate passed'], operations: ['check Exclusive Writer Lock', 'check vault filesystem profile', 'check semantic dependency', 'check compatibility', 'recover derived views', 'check Work Journal', 'open Control Channel'],
    receipts: ['ReadinessReceipt:ready'], terminal: 'ready',
  });
}

function controlCommand(initial, action) {
  if (initial.control_channel.state !== 'open' || !initial.control_channel.same_user_authenticated || !initial.control_channel.local_transport || action.command_vault_id !== initial.control_channel.vault_id) {
    return rejected(initial, action, 'control.authentication_denied');
  }
  if (action.command_version !== initial.control_channel.command_version) return rejected(initial, action, 'control.command_stale');
  return observed(initial, action, {
    outputs: ['authenticated local Control Command accepted'],
    operations: ['verify Unix-domain transport', 'verify same-user peer credentials', 'verify vault scope', 'compare command version', 'admit Control Command'],
    receipts: [`ControlCommandReceipt:${action.command_version}`], terminal: 'ready',
  });
}

function acquireWriter(initial, action) {
  if (initial.writer_owner_agent_id !== null) return rejected(initial, action, 'control.writer_owner_conflict', {terminal: 'blocked'});
  if (action.candidate_agent_id !== initial.persistent_agent_id) return rejected(initial, action, 'control.writer_identity_invalid', {terminal: 'blocked'});
  if (!writerReceiptIsCurrent(initial, action)) return rejected(initial, action, 'control.writer_receipt_invalid', {terminal: 'blocked'});
  return observed(initial, action, {
    outputs: ['Exclusive Writer Lock acquired', 'Exclusive Writer Lock retained'],
    operations: ['compare writer epoch', 'acquire Exclusive Writer Lock', 'revalidate lock token', 'retain Exclusive Writer Lock'],
    receipts: [`WriterLockReceipt:${action.candidate_agent_id}:${action.writer_lock_receipt.epoch}`],
    effects: ['create protected per-vault writer lock'], terminal: 'ready',
  });
}

export async function observeControlPlaneScenario(subject, packageRoot) {
  const errors = await validateAgainstSchemaPath(packageRoot, subject.schema, subject.document);
  const schemaCode = schemaErrorCode(errors);
  if (schemaCode !== null) {
    return {verdict: 'fail', codes: [schemaCode], outputs: ['scenario rejected'], operations: ['validate control-plane scenario'], receipts: ['ControlPlaneRejectionReceipt:schema'], filesystem_effects: ['none'], terminal_state: 'rejected', illegal_transition: false};
  }
  const {action, initial} = subject.document;
  if (!workStateIsConsistent(initial.work)) return rejected(initial, action, 'control.work_state_invalid');
  if (['cancelled', 'succeeded', 'failed'].includes(initial.work?.state) && !validCompletionReceipt(initial, initial.work)) {
    return rejected(initial, action, 'control.completion_receipt_invalid', {terminal: 'blocked'});
  }
  if (action.semantic_write_requested === (action.authority_source === 'none')) return rejected(initial, action, 'control.semantic_authority_binding_invalid');
  if (authorityByAction.get(action.kind) !== action.actor_role) return rejected(initial, action, 'control.actor_authority_denied');
  switch (action.kind) {
    case 'enqueue': return enqueue(initial, action);
    case 'dispatch': return dispatch(initial, action);
    case 'acknowledge': return acknowledge(initial, action);
    case 'fail': return fail(initial, action);
    case 'retry': return retry(initial, action);
    case 'cancel': return cancel(initial, action);
    case 'resume': return resume(initial, action);
    case 'restart': return restart(initial, action);
    case 'recover': return recover(initial, action);
    case 'readiness_check': return readinessCheck(initial, action);
    case 'control_command': return controlCommand(initial, action);
    case 'acquire_writer': return acquireWriter(initial, action);
    default: throw new Error('scenario schema allowed an unknown control-plane action');
  }
}
