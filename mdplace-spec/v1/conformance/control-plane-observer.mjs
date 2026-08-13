import {createHash} from 'node:crypto';

import {signControlPlaneReceipt, verifyControlPlaneReceipt} from './control-plane-authentication.mjs';
import {
  cancellationReceiptFields as cancellationFields,
  completionReceiptFields as completionFields,
  controlPlaneLimits,
  controlPlaneSemanticHead,
  enqueueReceiptFields as enqueueFields,
  readinessGateReceiptFields as readinessFields,
  resumeReceiptFields as resumeFields,
  schedulerLeaseReceiptFields as schedulerLeaseFields,
  vaultOwnerReceiptFields as vaultOwnerFields,
  writerLockReceiptFields as writerLockFields,
} from './control-plane-contract-values.mjs';
import {controlPlaneOutcomeFieldsAreValid} from './control-plane-outcome.mjs';
import {
  leaseReceiptFields as leaseFields,
  recoveryReceiptFields as recoveryFields,
  scenarioLifecycleDigestAtSequence,
  scenarioLifecycleIsValid,
} from './control-plane-scenario-history.mjs';
import {schemaErrorCode, validateAgainstSchemaPath} from './json-schema.mjs';
import {canonicalJson} from './semantic-kernel-core.mjs';

const authorityByAction = new Map([
  ['enqueue', 'work_submitter'],
  ['dispatch', 'scheduler'],
  ['acknowledge', 'mdplace_agent'],
  ['complete_work', 'mdplace_agent'],
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

function digestCanonical(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function journalHeadFields(receipt) {
  return [receipt.receipt_id, receipt.journal_id, receipt.head_sequence, receipt.head_digest];
}

function dependencyStateFields(receipt) {
  return [receipt.receipt_id, digestCanonical(receipt.dependencies)];
}

function journalHeadIsAuthenticated(initial) {
  const receipt = initial.journal_head_receipt;
  return receipt.head_sequence === initial.journal_head_sequence &&
    receipt.head_digest === initial.journal_head_digest &&
    receipt.journal_id === `journal:${initial.vault_id.replace(':', '-')}` &&
    verifyControlPlaneReceipt('work_journal_head', journalHeadFields(receipt), receipt, initial.persistent_agent_id);
}

function dependencyStateIsAuthenticated(initial) {
  const receipt = initial.dependency_state_receipt;
  const semanticDependencies = receipt.dependencies.filter(({kind}) => kind === 'semantic_head');
  const workDependenciesAreExact = initial.work === null ||
    canonicalJson(initial.work.dependencies) === canonicalJson(receipt.dependencies);
  return semanticDependencies.length === 1 &&
    semanticDependencies[0].reference_id === controlPlaneSemanticHead.referenceId &&
    semanticDependencies[0].version === controlPlaneSemanticHead.version &&
    semanticDependencies[0].digest === controlPlaneSemanticHead.digest &&
    initial.semantic_state_version === controlPlaneSemanticHead.version &&
    initial.semantic_state_digest === controlPlaneSemanticHead.digest &&
    workDependenciesAreExact &&
    digestCanonical(receipt.dependencies) === initial.dependency_state_digest &&
    verifyControlPlaneReceipt('dependency_state', dependencyStateFields(receipt), receipt, initial.persistent_agent_id);
}

function latestPriorStartReceipt(initial, work, leaseId, beforeSequence) {
  return initial.prior_lease_receipts.filter((prior) =>
    prior.receipt_kind === 'start' && prior.lease_id === leaseId &&
    prior.work_id === work.work_id && prior.work_version <= work.work_version &&
    prior.journal_sequence < beforeSequence && prior.owner_agent_id === initial.persistent_agent_id &&
    verifyControlPlaneReceipt('work_lease', leaseFields(prior), prior, initial.persistent_agent_id))
    .reduce((latest, receipt) => latest === null || receipt.journal_sequence > latest.journal_sequence
      ? receipt : latest, null);
}

function validPriorLeaseReceipt(initial, work, leaseId, beforeSequence, observedTick = null,
  requiredStatus = null) {
  if (typeof leaseId !== 'string') return false;
  const applicable = initial.prior_lease_receipts.filter((prior) =>
    prior.work_id === work.work_id && prior.work_version <= work.work_version &&
    prior.journal_sequence < beforeSequence && prior.owner_agent_id === work.owner_agent_id &&
    prior.expires_tick > prior.acquired_tick &&
    prior.expires_tick - prior.acquired_tick <= controlPlaneLimits.leaseDurationTicks &&
    prior.owner_agent_id === initial.persistent_agent_id &&
    verifyControlPlaneReceipt('work_lease', leaseFields(prior), prior, initial.persistent_agent_id));
  const latest = applicable.reduce((candidate, prior) =>
    candidate === null || prior.journal_sequence > candidate.journal_sequence ? prior : candidate, null);
  const currentLeaseMatches = work.lease_id !== leaseId ||
    work.lease_acquired_tick === latest?.acquired_tick && work.lease_expires_tick === latest?.expires_tick &&
    ['active', 'expired', 'revoked'].includes(work.lease_status);
  const observedWithinLease = observedTick === null || latest !== null &&
    observedTick >= (latest.started_tick ?? latest.acquired_tick) && observedTick < latest.expires_tick;
  const statusIsApplicable = requiredStatus === null || latest?.status === requiredStatus &&
    (work.lease_id !== leaseId || work.lease_status === requiredStatus);
  return latest?.lease_id === leaseId && currentLeaseMatches && observedWithinLease && statusIsApplicable;
}

function leaseHistoryIsValid(initial) {
  return scenarioLifecycleIsValid(initial);
}

function validPriorFailedRecoveryReceipt(initial, work, completion) {
  const receipts = initial.prior_recovery_receipts ?? [];
  const receipt = receipts.find((candidate) =>
    candidate.work_id === work.work_id && candidate.work_version === work.work_version &&
    candidate.lease_id === completion?.lease_id &&
    candidate.journal_sequence + 1 === completion?.journal_sequence &&
    candidate.recovery_decision === 'fail' && candidate.resulting_state === 'failed' &&
    candidate.resulting_retry_count === work.retry_count &&
    candidate.recovery_interruption_count === work.recovery_interruption_count);
  if (receipt === undefined) return false;
  const retryDelay = receipt.prior_state === 'executing' && receipt.prior_retry_count < work.retry_ceiling
    ? controlPlaneLimits.retryDelays[receipt.prior_retry_count] : null;
  const expectedCode = receipt.recovery_interruption_count > controlPlaneLimits.recoveryInterruptionCeiling
    ? 'control.recovery_ceiling_exceeded'
    : receipt.prior_state === 'executing' && receipt.prior_retry_count >= work.retry_ceiling
      ? 'control.retry_ceiling_exceeded'
      : receipt.prior_state === 'executing' &&
        receipt.recovery_tick + retryDelay > controlPlaneLimits.latestDispatchTick
        ? 'control.retry_tick_overflow' : null;
  const failureBasisIsExact = expectedCode === 'control.recovery_ceiling_exceeded'
    ? completion.failure_retryable === null && completion.failure_observed_tick === null &&
      completion.selected_retry_delay_ticks === null && receipt.selected_retry_delay_ticks === null
    : completion.failure_retryable === true && completion.failure_observed_tick === receipt.recovery_tick &&
      completion.selected_retry_delay_ticks === (expectedCode === 'control.retry_tick_overflow' ? retryDelay : null) &&
      receipt.selected_retry_delay_ticks === (expectedCode === 'control.retry_tick_overflow' ? retryDelay : null);
  return expectedCode !== null && completion.code === expectedCode && failureBasisIsExact;
}

function cancellationReceiptFor(initial, work, action) {
  const receipt = {
    receipt_id: `cancellation-receipt:${work.work_id.slice(5)}-v${work.work_version}`,
    cancellation_id: `cancel:${work.work_id.slice(5)}-v${work.work_version}`,
    work_id: work.work_id,
    work_version: work.work_version,
    idempotency_key: action.idempotency_key,
    requested_by: action.vault_owner_receipt.principal_id,
    vault_owner_receipt: structuredClone(action.vault_owner_receipt),
    journal_sequence: initial.journal_head_sequence + 1,
    cancellation_tick: action.current_tick,
    reason_code: 'user_requested',
    resume_count: work.resume_count,
    resume_ceiling: work.resume_ceiling,
  };
  return {...receipt, ...signControlPlaneReceipt('work_journal_cancellation', cancellationFields(receipt))};
}

function enqueueReceiptFor(initial, work, action) {
  const receipt = {
    receipt_id: `enqueue-receipt:${work.work_id.slice(5)}`,
    work_id: work.work_id,
    work_version: work.work_version,
    idempotency_key: work.idempotency_key,
    input_digest: work.input_digest,
    base_head_sequence: action.expected_journal_head_sequence,
    base_head_digest: action.expected_journal_head_digest,
    journal_sequence: initial.journal_head_sequence + 1,
  };
  return {...receipt, ...signControlPlaneReceipt('work_enqueue', enqueueFields(receipt))};
}

function validStoredEnqueueReceipt(initial, work) {
  const receipt = work?.enqueue_receipt;
  return receipt !== null && receipt !== undefined && receipt.work_id === work.work_id &&
    receipt.work_version === 1 && receipt.work_version <= work.work_version &&
    receipt.idempotency_key === work.idempotency_key && receipt.input_digest === work.input_digest &&
    receipt.journal_sequence === receipt.base_head_sequence + 1 &&
    receipt.journal_sequence <= initial.journal_head_sequence &&
    verifyControlPlaneReceipt('work_enqueue', enqueueFields(receipt), receipt, initial.persistent_agent_id);
}

function vaultOwnerIsAuthenticated(initial, action) {
  const receipt = action.vault_owner_receipt;
  return controlChannelIsCurrent(initial) && receipt !== null &&
    receipt.vault_id === initial.vault_id &&
    receipt.action_kind === action.kind && receipt.work_id === action.work_id &&
    receipt.work_version === action.expected_work_version &&
    receipt.lease_id === action.lease_id &&
    receipt.idempotency_key === action.idempotency_key &&
    verifyControlPlaneReceipt('vault_owner_authorization', vaultOwnerFields(receipt), receipt,
      initial.persistent_agent_id);
}

function resumeReceiptFor(initial, work, action) {
  const cancellation = initial.work.cancellation_receipt;
  const cancellationCompletion = initial.work.completion_receipt;
  const receipt = {
    receipt_id: `resume-receipt:${work.work_id.slice(5)}`,
    work_id: work.work_id,
    cancelled_work_version: initial.work.work_version,
    resumed_work_version: work.work_version,
    idempotency_key: action.idempotency_key,
    vault_owner_receipt: structuredClone(action.vault_owner_receipt),
    cancellation_receipt_id: cancellation.receipt_id,
    cancellation_receipt_signature_digest: cancellation.signature_digest,
    cancellation_completion_receipt_id: cancellationCompletion.receipt_id,
    cancellation_completion_signature_digest: cancellationCompletion.signature_digest,
    resume_count: work.resume_count,
    journal_sequence: initial.journal_head_sequence + 1,
  };
  return {...receipt, ...signControlPlaneReceipt('work_resume', resumeFields(receipt))};
}

function validStoredResumeReceipt(initial, work) {
  const receipt = work?.resume_receipt;
  const cancellation = work?.cancellation_history?.find((candidate) =>
    candidate.receipt_id === receipt?.cancellation_receipt_id);
  const completion = work?.completion_history?.find((candidate) =>
    candidate.receipt_id === receipt?.cancellation_completion_receipt_id);
  return receipt !== null && receipt !== undefined && work.resume_count === 1 &&
    receipt.work_id === work.work_id && receipt.resumed_work_version <= work.work_version &&
    receipt.cancelled_work_version === receipt.resumed_work_version - 1 &&
    receipt.idempotency_key === work.idempotency_key &&
    receipt.vault_owner_receipt?.action_kind === 'resume' &&
    receipt.vault_owner_receipt.principal_id === 'person:owner-001' &&
    receipt.vault_owner_receipt.vault_id === initial.vault_id &&
    receipt.vault_owner_receipt.work_id === work.work_id &&
    receipt.vault_owner_receipt.work_version === receipt.cancelled_work_version &&
    receipt.vault_owner_receipt.lease_id === null &&
    receipt.vault_owner_receipt.idempotency_key === work.idempotency_key &&
    cancellation?.work_id === work.work_id && cancellation.work_version === receipt.cancelled_work_version &&
    cancellation.idempotency_key === work.idempotency_key && cancellation.resume_count + 1 === receipt.resume_count &&
    cancellation.signature_digest === receipt.cancellation_receipt_signature_digest &&
    cancellation.journal_sequence < receipt.journal_sequence &&
    completion?.work_id === work.work_id && completion.work_version === cancellation.work_version &&
    completion.outcome === 'cancelled' && completion.lease_id === cancellation.vault_owner_receipt.lease_id &&
    completion?.journal_sequence === cancellation.journal_sequence + 1 &&
    receipt.journal_sequence === completion.journal_sequence + 1 &&
    completion.signature_digest === receipt.cancellation_completion_signature_digest &&
    controlPlaneOutcomeFieldsAreValid(completion, {
      retryCount: work.retry_count, retryCeiling: work.retry_ceiling,
      recoveryInterruptionCount: work.recovery_interruption_count,
      recoveryCeiling: controlPlaneLimits.recoveryInterruptionCeiling,
      retryDelays: controlPlaneLimits.retryDelays,
      latestDispatchTick: controlPlaneLimits.latestDispatchTick,
    }) &&
    verifyControlPlaneReceipt('vault_owner_authorization', vaultOwnerFields(receipt.vault_owner_receipt),
      receipt.vault_owner_receipt, initial.persistent_agent_id) &&
    verifyControlPlaneReceipt('vault_owner_authorization', vaultOwnerFields(cancellation.vault_owner_receipt),
      cancellation.vault_owner_receipt, initial.persistent_agent_id) &&
    verifyControlPlaneReceipt('work_journal_cancellation', cancellationFields(cancellation),
      cancellation, initial.persistent_agent_id) &&
    verifyControlPlaneReceipt('work_completion', completionFields(completion), completion,
      initial.persistent_agent_id) &&
    receipt.resume_count === work.resume_count && receipt.journal_sequence <= initial.journal_head_sequence &&
    verifyControlPlaneReceipt('work_resume', resumeFields(receipt), receipt, initial.persistent_agent_id);
}

function validStoredCancellationReceipt(initial, work) {
  const receipt = work?.cancellation_receipt;
  return receipt !== null && receipt !== undefined && work.state === 'cancelled' &&
    receipt.idempotency_key === work.idempotency_key && receipt.cancellation_id === work.cancellation_id &&
    receipt.work_id === work.work_id && receipt.work_version === work.work_version &&
    Number.isInteger(receipt.cancellation_tick) &&
    receipt.journal_sequence <= initial.journal_head_sequence &&
    receipt.requested_by === 'person:owner-001' && receipt.resume_count === work.resume_count &&
    receipt.resume_ceiling === work.resume_ceiling &&
    receipt.vault_owner_receipt.action_kind === 'cancel' &&
    work.cancellation_history.at(-1)?.receipt_id === receipt.receipt_id &&
    verifyControlPlaneReceipt('vault_owner_authorization', vaultOwnerFields(receipt.vault_owner_receipt),
      receipt.vault_owner_receipt, initial.persistent_agent_id) &&
    verifyControlPlaneReceipt('work_journal_cancellation', cancellationFields(receipt), receipt, initial.persistent_agent_id);
}

function validCancellationReceipt(initial, action) {
  return validStoredCancellationReceipt(initial, initial.work) &&
    action.idempotency_key === initial.work.cancellation_receipt.idempotency_key;
}

function schedulerSnapshotDigest(initial) {
  return digestCanonical({
    active_lease_ids: [...initial.active_lease_ids].sort(),
    max_concurrent_work: initial.max_concurrent_work,
  });
}

function representedActiveLeasesAt(initial, observationTick) {
  if (initial.work === null) return [];
  const work = initial.work;
  const acquisitions = initial.prior_lease_receipts.filter(({receipt_kind: kind}) => kind === 'lease');
  const starts = initial.prior_lease_receipts.filter(({receipt_kind: kind}) => kind === 'start');
  const ends = [
    ...(initial.prior_retry_receipts ?? []).map((receipt) => ({
      lease_id: receipt.lease_id, tick: receipt.failure_tick,
    })),
    ...(initial.prior_recovery_receipts ?? []).map((receipt) => ({
      lease_id: receipt.lease_id, tick: receipt.recovery_tick,
    })),
    ...work.cancellation_history.map((receipt) => ({
      lease_id: receipt.vault_owner_receipt.lease_id, tick: receipt.cancellation_tick,
    })),
    ...work.completion_history.map((receipt) => ({
      lease_id: receipt.lease_id, tick: receipt.completion_tick,
    })),
  ];
  return acquisitions.flatMap((lease) => {
    const endTick = ends.filter(({lease_id: id}) => id === lease.lease_id)
      .reduce((earliest, {tick}) => Math.min(earliest, tick), lease.expires_tick);
    if (lease.acquired_tick > observationTick || observationTick >= endTick) return [];
    const start = starts.filter((receipt) => receipt.lease_id === lease.lease_id &&
      receipt.started_tick <= observationTick)
      .reduce((latest, receipt) => latest === null || receipt.started_tick > latest.started_tick
        ? receipt : latest, null);
    return [{
      lease_id: lease.lease_id, work_id: lease.work_id,
      work_version: start?.work_version ?? lease.work_version,
      owner_agent_id: lease.owner_agent_id, acquired_tick: lease.acquired_tick,
      expires_tick: lease.expires_tick, status: 'active',
    }];
  });
}

function schedulerSnapshotIsConsistent(initial, requiredObservationTick = initial.scheduler_observed_tick) {
  const receipts = initial.scheduler_active_lease_receipts;
  const receiptLeaseIds = receipts.map(({lease_id: id}) => id);
  const prefixLeases = initial.journal_prefix_receipt.active_leases.filter((lease) =>
    lease.acquired_tick <= initial.scheduler_observed_tick &&
    initial.scheduler_observed_tick < lease.expires_tick);
  const activeWorkLeases = representedActiveLeasesAt(initial, initial.scheduler_observed_tick);
  const expectedLeases = [
    ...prefixLeases,
    ...activeWorkLeases,
  ];
  const receiptsMatchJournal = receipts.length === expectedLeases.length && receipts.every((receipt) =>
    expectedLeases.some((lease) => lease.lease_id === receipt.lease_id &&
      lease.work_id === receipt.work_id && lease.work_version === receipt.work_version &&
      lease.owner_agent_id === receipt.owner_agent_id &&
      lease.acquired_tick === receipt.acquired_tick && lease.expires_tick === receipt.expires_tick &&
      lease.status === receipt.status));
  return initial.scheduler_observed_tick === requiredObservationTick &&
    new Set(receiptLeaseIds).size === receipts.length &&
    receipts.every((receipt) => receipt.vault_id === initial.vault_id &&
      receipt.owner_agent_id === initial.persistent_agent_id &&
      receipt.status === 'active' && receipt.expires_tick > receipt.acquired_tick &&
      receipt.acquired_tick <= initial.scheduler_observed_tick &&
      initial.scheduler_observed_tick < receipt.expires_tick &&
      receipt.expires_tick - receipt.acquired_tick <= controlPlaneLimits.leaseDurationTicks &&
      verifyControlPlaneReceipt(
        'scheduler_active_lease', schedulerLeaseFields(receipt), receipt, initial.persistent_agent_id,
      )) &&
    canonicalJson([...initial.active_lease_ids].sort()) === canonicalJson([...receiptLeaseIds].sort()) &&
    initial.active_work_count === receipts.length &&
    initial.scheduler_state_digest === schedulerSnapshotDigest(initial) &&
    receiptsMatchJournal;
}

function completionReceiptFor(initial, work, outcome, outputDigest = null, leaseId = work.lease_id, code = null,
  sequenceOffset = 1, failureBasis = {}, baseHead = null) {
  const receipt = {
    receipt_id: `receipt:${outcome}-${work.work_id.slice(5)}-v${work.work_version}`,
    work_id: work.work_id,
    work_version: work.work_version,
    lease_id: leaseId,
    idempotency_key: work.idempotency_key,
    base_head_sequence: baseHead?.sequence ?? initial.journal_head_sequence,
    base_head_digest: baseHead?.digest ?? initial.journal_head_digest,
    journal_sequence: initial.journal_head_sequence + sequenceOffset,
    completion_tick: failureBasis.completionTick,
    outcome,
    output_digest: outputDigest,
    code,
    failure_retryable: failureBasis.retryable ?? null,
    failure_observed_tick: failureBasis.observedTick ?? null,
    selected_retry_delay_ticks: failureBasis.selectedDelay ?? null,
  };
  return {...receipt, ...signControlPlaneReceipt('work_completion', completionFields(receipt))};
}

function recoveryReceiptFor(initial, work, action, decision, selectedDelay = null) {
  const receipt = {
    receipt_id: `recovery-receipt:${work.work_id.slice(5)}-v${work.work_version}`,
    receipt_kind: 'recovery', lease_id: initial.work.lease_id, work_id: work.work_id,
    work_version: work.work_version, journal_sequence: initial.journal_head_sequence + 1,
    prior_state: initial.work.state, prior_retry_count: initial.work.retry_count,
    recovery_interruption_count: action.interruption_count,
    resulting_retry_count: work.retry_count, recovery_tick: action.recovery_tick,
    recovery_lease_status: 'expired', recovery_decision: decision,
    selected_retry_delay_ticks: selectedDelay, resulting_state: work.state,
  };
  return {...receipt, ...signControlPlaneReceipt('work_recovery', recoveryFields(receipt))};
}

function intermediateHead(initial, work, extraRecoveries = []) {
  const sequence = initial.journal_head_sequence + 1;
  const digest = scenarioLifecycleDigestAtSequence({
    ...initial, work,
    prior_recovery_receipts: [...(initial.prior_recovery_receipts ?? []), ...extraRecoveries],
  }, sequence);
  return {sequence, digest};
}

function validCompletionReceipt(initial, work) {
  const receipt = work?.completion_receipt;
  const recoveryReceiptIsValid = validPriorFailedRecoveryReceipt(initial, work, receipt);
  const leaseReceiptIsValid = validPriorLeaseReceipt(
    initial,
    {...work, owner_agent_id: initial.persistent_agent_id},
    receipt?.lease_id,
    receipt?.journal_sequence,
    recoveryReceiptIsValid ? null : receipt?.completion_tick,
    recoveryReceiptIsValid ? null : 'active',
  );
  const outputIsValid = controlPlaneOutcomeFieldsAreValid(receipt, {
    retryCount: work?.retry_count,
    retryCeiling: work?.retry_ceiling,
    recoveryInterruptionCount: work?.recovery_interruption_count,
    recoveryCeiling: controlPlaneLimits.recoveryInterruptionCeiling,
    retryDelays: controlPlaneLimits.retryDelays,
    latestDispatchTick: controlPlaneLimits.latestDispatchTick,
  });
  const leaseIsValid = recoveryReceiptIsValid || work?.state === 'cancelled'
    ? receipt?.lease_id === null || leaseReceiptIsValid
    : leaseReceiptIsValid;
  return receipt !== null && receipt !== undefined &&
    receipt.work_id === work.work_id && receipt.work_version === work.work_version &&
    receipt.idempotency_key === work.idempotency_key &&
    receipt.journal_sequence <= initial.journal_head_sequence &&
    receipt.outcome === work.state && outputIsValid && leaseIsValid &&
    (receipt.code !== 'control.recovery_ceiling_exceeded' || recoveryReceiptIsValid) &&
    receipt.signer_agent_id === initial.persistent_agent_id &&
    verifyControlPlaneReceipt('work_completion', completionFields(receipt), receipt, initial.persistent_agent_id);
}

function writerReceiptIsCurrent(initial, action) {
  const receipt = action.writer_lock_receipt;
  return receipt !== null && receipt.prior_epoch === initial.writer_epoch &&
    receipt.epoch === initial.writer_epoch + 1 && receipt.owner_agent_id === initial.persistent_agent_id &&
    receipt.retained === true && action.expected_writer_epoch === initial.writer_epoch &&
    verifyControlPlaneReceipt(
      'writer_lock', writerLockFields(receipt, initial.vault_id), receipt, initial.persistent_agent_id,
    );
}

function writerReceiptIsRetained(initial, action) {
  const receipt = action.writer_lock_receipt;
  return receipt !== null && initial.writer_epoch > 0 && receipt.prior_epoch === initial.writer_epoch - 1 &&
    receipt.epoch === initial.writer_epoch && receipt.owner_agent_id === initial.persistent_agent_id &&
    receipt.retained === true && action.expected_writer_epoch === initial.writer_epoch &&
    verifyControlPlaneReceipt(
      'writer_lock', writerLockFields(receipt, initial.vault_id), receipt, initial.persistent_agent_id,
    );
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
      observation.vault_id === initial.vault_id &&
      observation.previous_receipt_digest === previousReceiptDigest &&
      verifyControlPlaneReceipt(
        'readiness_gate', readinessFields(observation), observation, initial.persistent_agent_id,
      );
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

function journalCanAppend(initial, count = 1) {
  return initial.journal_head_sequence <= controlPlaneLimits.maxJournalSequence - count;
}

function controlChannelIsCurrent(initial) {
  return initial.control_channel.state === 'open' && initial.control_channel.same_user_authenticated === true &&
    initial.control_channel.local_transport === true;
}

function controlChannelIsClosedForStartup(initial) {
  return initial.control_channel.state === 'closed' &&
    initial.control_channel.same_user_authenticated === false;
}

function workStateIsConsistent(work) {
  if (work === null) return true;
  const scalarBoundsAreValid = Number.isInteger(work.work_version) && work.work_version >= 1 &&
    work.work_version <= controlPlaneLimits.maxTick &&
    Number.isInteger(work.retry_count) && work.retry_count >= 0 && work.retry_count <= work.retry_ceiling &&
    Number.isInteger(work.recovery_interruption_count) && work.recovery_interruption_count >= 0 &&
    work.recovery_interruption_count <= controlPlaneLimits.maxRecoveryInterruptionCount &&
    Number.isInteger(work.resume_count) && work.resume_count >= 0 && work.resume_count <= work.resume_ceiling;
  const leased = work.state === 'leased' || work.state === 'executing';
  const leaseIsBound = typeof work.lease_id === 'string' && typeof work.owner_agent_id === 'string' &&
    ['active', 'revoked', 'expired'].includes(work.lease_status) &&
    Number.isInteger(work.lease_acquired_tick) && Number.isInteger(work.lease_expires_tick) &&
    work.lease_acquired_tick >= 0 && work.lease_acquired_tick <= controlPlaneLimits.maxTick &&
    work.lease_expires_tick > work.lease_acquired_tick &&
    work.lease_expires_tick <= controlPlaneLimits.maxLeaseExpiryTick &&
    work.lease_expires_tick - work.lease_acquired_tick <= controlPlaneLimits.leaseDurationTicks;
  const leaseIsAbsent = work.lease_id === null && work.owner_agent_id === null && work.lease_status === null &&
    work.lease_acquired_tick === null && work.lease_expires_tick === null;
  const retryEligibilityIsValid = work.state === 'retry_wait'
    ? Number.isInteger(work.retry_eligible_tick) && work.retry_eligible_tick >= 0 &&
      work.retry_eligible_tick <= controlPlaneLimits.maxTick
    : work.retry_eligible_tick === null;
  const terminal = ['cancelled', 'succeeded', 'failed'].includes(work.state);
  const completionIsValid = terminal ? work.completion_receipt !== null : work.completion_receipt === null;
  const completionBoundsAreValid = !terminal ||
    work.completion_receipt.journal_sequence <= controlPlaneLimits.maxJournalSequence;
  const cancellationIsValid = work.state === 'cancelled'
    ? work.cancellation_receipt !== null && work.cancellation_id === work.cancellation_receipt.cancellation_id
    : work.cancellation_receipt === null || work.resume_count > 0;
  const resumeIsValid = work.resume_count === 0
    ? work.resume_receipt === null
    : work.resume_receipt !== null;
  const enqueueIsValid = work.enqueue_receipt !== null;
  const cancellationHistoryIsValid = Array.isArray(work.cancellation_history) &&
    work.cancellation_history.length === work.resume_count + (work.state === 'cancelled' ? 1 : 0) &&
    new Set(work.cancellation_history.map(({receipt_id: id}) => id)).size === work.cancellation_history.length &&
    (work.cancellation_receipt === null ||
      canonicalJson(work.cancellation_history.at(-1)) === canonicalJson(work.cancellation_receipt));
  const completionHistoryIsValid = Array.isArray(work.completion_history) &&
    work.completion_history.length === work.cancellation_history.length +
      (terminal && work.state !== 'cancelled' ? 1 : 0) &&
    new Set(work.completion_history.map(({receipt_id: id}) => id)).size === work.completion_history.length &&
    (work.completion_receipt === null ||
      canonicalJson(work.completion_history.at(-1)) === canonicalJson(work.completion_receipt));
  return scalarBoundsAreValid && enqueueIsValid && (leased ? leaseIsBound : leaseIsAbsent) && retryEligibilityIsValid && completionIsValid &&
    completionBoundsAreValid && cancellationHistoryIsValid && completionHistoryIsValid &&
    cancellationIsValid && resumeIsValid && (!terminal || work.completion_receipt.outcome === work.state);
}

function workHistoryIsAuthenticated(initial, work) {
  if (work === null) return true;
  return work.cancellation_history.every((receipt) => {
    const completion = work.completion_history.find((candidate) =>
      candidate.work_version === receipt.work_version && candidate.outcome === 'cancelled');
    const cancellationLeaseIsValid = receipt.vault_owner_receipt.lease_id === null ||
      validPriorLeaseReceipt(initial, {...work, owner_agent_id: initial.persistent_agent_id},
        receipt.vault_owner_receipt.lease_id, receipt.journal_sequence,
        receipt.cancellation_tick, 'active');
    return receipt.work_id === work.work_id && receipt.idempotency_key === work.idempotency_key &&
    receipt.requested_by === receipt.vault_owner_receipt.principal_id &&
    receipt.vault_owner_receipt.action_kind === 'cancel' &&
    receipt.vault_owner_receipt.work_id === receipt.work_id &&
    receipt.vault_owner_receipt.work_version === receipt.work_version - 1 &&
    receipt.vault_owner_receipt.idempotency_key === receipt.idempotency_key &&
    receipt.vault_owner_receipt.vault_id === initial.vault_id &&
    completion?.work_id === work.work_id && completion.work_version === receipt.work_version &&
    completion.lease_id === receipt.vault_owner_receipt.lease_id &&
    completion.journal_sequence === receipt.journal_sequence + 1 &&
    cancellationLeaseIsValid &&
    controlPlaneOutcomeFieldsAreValid(completion, {
      retryCount: work.retry_count, retryCeiling: work.retry_ceiling,
      recoveryInterruptionCount: work.recovery_interruption_count,
      recoveryCeiling: controlPlaneLimits.recoveryInterruptionCeiling,
      retryDelays: controlPlaneLimits.retryDelays,
      latestDispatchTick: controlPlaneLimits.latestDispatchTick,
    }) &&
    verifyControlPlaneReceipt('vault_owner_authorization', vaultOwnerFields(receipt.vault_owner_receipt),
      receipt.vault_owner_receipt, initial.persistent_agent_id) &&
    verifyControlPlaneReceipt('work_journal_cancellation', cancellationFields(receipt), receipt,
      initial.persistent_agent_id) &&
    verifyControlPlaneReceipt('work_completion', completionFields(completion), completion,
      initial.persistent_agent_id);
  }) &&
    work.completion_history.every((receipt) =>
      receipt.work_id === work.work_id && receipt.journal_sequence <= initial.journal_head_sequence &&
      verifyControlPlaneReceipt('work_completion', completionFields(receipt), receipt,
        initial.persistent_agent_id));
}

function enqueue(initial, action) {
  if (!initial.journal_available) return rejected(initial, action, 'control.journal_unavailable', {terminal: 'blocked'});
  if (initial.work !== null) {
    const compatible = action.work_id === initial.work.work_id &&
      action.idempotency_key === initial.work.idempotency_key &&
      action.proposed_work_input_digest === initial.work.input_digest &&
      validStoredEnqueueReceipt(initial, initial.work) &&
      action.expected_journal_head_sequence === initial.work.enqueue_receipt.base_head_sequence &&
      action.expected_journal_head_digest === initial.work.enqueue_receipt.base_head_digest;
    if (!compatible) return rejected(initial, action, 'control.idempotency_incompatible');
    return observed(initial, action, {
      outputs: ['enqueue idempotent'], operations: ['read Work Journal', 'resolve idempotency binding'],
      receipts: [`EnqueueReceipt:${initial.work.work_id}`], terminal: initial.work.state,
    });
  }
  if (action.expected_journal_head_sequence !== initial.journal_head_sequence ||
      action.expected_journal_head_digest !== initial.journal_head_digest) {
    return rejected(initial, action, 'control.journal_head_stale', {terminal: 'blocked'});
  }
  if (action.work_id === null || action.idempotency_key === null || action.proposed_work_input_digest === null) {
    return rejected(initial, action, 'control.enqueue_binding_missing');
  }
  if (!journalCanAppend(initial)) return rejected(initial, action, 'control.journal_capacity_exhausted', {terminal: 'blocked'});
  const work = {
    work_id: action.work_id, work_version: 1, state: 'queued', idempotency_key: action.idempotency_key,
    input_digest: action.proposed_work_input_digest,
    dependencies: structuredClone(initial.dependency_state_receipt.dependencies),
    enqueue_receipt: null, retry_count: 0,
    retry_ceiling: controlPlaneLimits.retryCeiling,
    retry_eligible_tick: null, recovery_interruption_count: 0,
    lease_id: null, lease_status: null, lease_acquired_tick: null, lease_expires_tick: null,
    owner_agent_id: null, cancellation_id: null, resume_count: 0,
    resume_ceiling: controlPlaneLimits.resumeCeiling,
    cancellation_receipt: null, cancellation_history: [], resume_receipt: null,
    completion_receipt: null, completion_history: [],
  };
  work.enqueue_receipt = enqueueReceiptFor(initial, work, action);
  return observed(initial, action, {
    outputs: [action.interruption_count > 0 ? 'enqueue recovered after process loss' : 'enqueue accepted'],
    operations: ['validate Work Journal availability', 'resolve idempotency binding', 'append enqueue record', 'read committed enqueue after interruption'],
    receipts: [`EnqueueReceipt:${work.work_id}`], effects: ['append durable Work Journal record'],
    terminal: 'queued', work,
  });
}

function dispatch(initial, action) {
  if (initial.agent_state !== 'ready' || initial.writer_owner_agent_id !== initial.persistent_agent_id ||
      !initial.journal_available || !initial.semantic_dependency_available || !controlChannelIsCurrent(initial)) {
    return rejected(initial, action, 'control.agent_not_ready', {terminal: 'blocked'});
  }
  if (initial.work?.state === 'leased' || initial.work?.state === 'executing') {
    return rejected(initial, action, 'control.owner_conflict', {terminal: initial.work.state});
  }
  if (action.expected_journal_head_sequence !== initial.journal_head_sequence) {
    return rejected(initial, action, 'control.journal_head_stale', {terminal: 'blocked'});
  }
  if (action.expected_journal_head_digest !== initial.journal_head_digest) {
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
  if (!schedulerSnapshotIsConsistent(initial, Number.isInteger(action.current_tick)
    ? action.current_tick : initial.scheduler_observed_tick) ||
      action.expected_scheduler_state_digest !== initial.scheduler_state_digest) {
    return rejected(initial, action, 'control.scheduler_base_stale', {terminal: 'blocked'});
  }
  if (initial.active_lease_ids.length >= initial.max_concurrent_work) {
    return rejected(initial, action, 'control.concurrency_budget_exhausted', {terminal: 'blocked'});
  }
  if (!exactWorkBase(initial, action)) return rejected(initial, action, 'control.work_version_stale');
  if (!['queued', 'retry_wait'].includes(initial.work.state) || action.lease_id === null) {
    return rejected(initial, action, 'control.illegal_transition', {illegal: true, terminal: initial.work.state});
  }
  if (!journalCanAppend(initial)) return rejected(initial, action, 'control.journal_capacity_exhausted', {terminal: 'blocked'});
  if (!Number.isInteger(action.current_tick)) return rejected(initial, action, 'control.current_tick_missing', {terminal: 'blocked'});
  if (action.current_tick > controlPlaneLimits.latestDispatchTick) {
    return rejected(initial, action, 'control.lease_tick_overflow', {terminal: 'blocked'});
  }
  if (initial.work.state === 'retry_wait' && action.current_tick < initial.work.retry_eligible_tick) {
    return rejected(initial, action, 'control.retry_not_eligible', {terminal: 'retry_wait'});
  }
  const acquiredTick = action.current_tick;
  const work = {...initial.work, work_version: initial.work.work_version + 1, state: 'leased',
    retry_eligible_tick: null, lease_id: action.lease_id, lease_status: 'active',
    lease_acquired_tick: acquiredTick,
    lease_expires_tick: acquiredTick + controlPlaneLimits.leaseDurationTicks,
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
  if (!Number.isInteger(action.current_tick) || action.current_tick < initial.work.lease_acquired_tick ||
      action.current_tick >= initial.work.lease_expires_tick) {
    return rejected(initial, action, 'control.lease_stale', {terminal: initial.work.state});
  }
  if (!journalCanAppend(initial)) return rejected(initial, action, 'control.journal_capacity_exhausted', {terminal: 'blocked'});
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
      action.current_tick < latestPriorStartReceipt(
        initial, initial.work, initial.work.lease_id, initial.journal_head_sequence + 1,
      )?.started_tick || action.current_tick >= initial.work.lease_expires_tick) {
    return rejected(initial, action, 'control.lease_stale', {terminal: initial.work.state});
  }
  if (!journalCanAppend(initial)) return rejected(initial, action, 'control.journal_capacity_exhausted', {terminal: 'blocked'});
  if (action.retryable && initial.work.retry_count < initial.work.retry_ceiling) {
    const nextRetryCount = initial.work.retry_count + 1;
    const retryDelay = controlPlaneLimits.retryDelays[nextRetryCount - 1];
    const retryEligibleTick = action.current_tick + retryDelay;
    if (retryEligibleTick <= controlPlaneLimits.latestDispatchTick) {
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
  work.completion_receipt = completionReceiptFor(initial, work, 'failed', null, initial.work.lease_id,
    action.retryable && initial.work.retry_count < initial.work.retry_ceiling
      ? 'control.retry_tick_overflow'
      : action.retryable ? 'control.retry_ceiling_exceeded' : 'control.execution_failed', 1, {
      retryable: action.retryable,
      observedTick: action.current_tick,
      completionTick: action.current_tick,
      selectedDelay: action.retryable && initial.work.retry_count < initial.work.retry_ceiling
        ? controlPlaneLimits.retryDelays[initial.work.retry_count] : null,
    });
  work.completion_history = [...initial.work.completion_history, work.completion_receipt];
  return observed(initial, action, {
    outputs: [!action.retryable ? 'execution failure produced terminal failure'
      : action.retryable && initial.work.retry_count < initial.work.retry_ceiling
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
  if (!vaultOwnerIsAuthenticated(initial, action)) return rejected(initial, action, 'control.vault_owner_authentication_denied');
  if (!exactWorkBase(initial, action)) return rejected(initial, action, 'control.work_version_stale');
  const requiresLease = ['leased', 'executing'].includes(initial.work.state);
  if ((requiresLease && action.lease_id !== initial.work.lease_id) ||
      (requiresLease && initial.work.lease_status !== 'active') ||
      (requiresLease && (!Number.isInteger(action.current_tick) ||
        action.current_tick < (initial.work.state === 'executing'
          ? latestPriorStartReceipt(
            initial, initial.work, initial.work.lease_id, initial.journal_head_sequence + 1,
          )?.started_tick
          : initial.work.lease_acquired_tick) ||
        action.current_tick >= initial.work.lease_expires_tick)) ||
      (!requiresLease && action.lease_id !== null)) {
    return rejected(initial, action, 'control.lease_stale', {terminal: initial.work.state});
  }
  if (initial.work.state === 'cancelled') {
    if (!validCancellationReceipt(initial, action)) {
      return rejected(initial, action, 'control.cancellation_receipt_invalid', {terminal: 'cancelled'});
    }
    return observed(initial, action, {
      outputs: ['cancellation idempotent'], operations: ['compare Work Item version', 'return original cancellation receipt'],
      receipts: [`CancellationReceipt:${initial.work.cancellation_receipt.receipt_id}`], terminal: 'cancelled',
    });
  }
  if (!['queued', 'leased', 'executing', 'retry_wait'].includes(initial.work.state)) {
    return rejected(initial, action, 'control.illegal_transition', {illegal: true, terminal: initial.work.state});
  }
  if (!Number.isInteger(action.current_tick)) {
    return rejected(initial, action, 'control.current_tick_missing', {terminal: initial.work.state});
  }
  if (!journalCanAppend(initial, 2)) return rejected(initial, action, 'control.journal_capacity_exhausted', {terminal: 'blocked'});
  if (action.idempotency_key !== initial.work.idempotency_key) {
    return rejected(initial, action, 'control.idempotency_incompatible');
  }
  const wasExecuting = initial.work.state === 'executing';
  const work = {...initial.work, work_version: initial.work.work_version + 1, state: 'cancelled',
    retry_eligible_tick: null, lease_id: null, lease_status: null, lease_acquired_tick: null,
    lease_expires_tick: null, owner_agent_id: null};
  work.cancellation_receipt = cancellationReceiptFor(initial, work, action);
  work.cancellation_id = work.cancellation_receipt.cancellation_id;
  work.cancellation_history = [...initial.work.cancellation_history, work.cancellation_receipt];
  work.completion_receipt = completionReceiptFor(initial, {...work, lease_id: initial.work.lease_id}, 'cancelled', null,
    initial.work.lease_id, 'control.cancelled', 2, {completionTick: action.current_tick},
    intermediateHead(initial, work));
  work.completion_history = [...initial.work.completion_history, work.completion_receipt];
  return observed(initial, action, {
    outputs: [wasExecuting ? 'in-flight cancellation durable' : 'queued cancellation durable'],
    operations: ['compare Work Item version', 'append cancellation record', 'append terminal completion record',
      ...(wasExecuting ? ['revoke Child Work Invocation'] : [])],
    receipts: [`CancellationReceipt:${work.cancellation_receipt.receipt_id}`,
      `CompletionReceipt:${work.completion_receipt.receipt_id}`],
    effects: ['append durable cancellation record', 'append durable terminal completion record',
      ...(wasExecuting ? ['terminate Child Work Invocation capability'] : [])],
    terminal: 'cancelled', work,
  });
}

function resume(initial, action) {
  if (action.lease_id !== null) return rejected(initial, action, 'control.lease_stale', {terminal: initial.work?.state ?? 'rejected'});
  if (!vaultOwnerIsAuthenticated(initial, action)) return rejected(initial, action, 'control.vault_owner_authentication_denied');
  if (initial.work.state === 'queued' &&
      initial.work.resume_receipt?.resumed_work_version === initial.work.work_version &&
      validStoredResumeReceipt(initial, initial.work) && action.work_id === initial.work.work_id &&
      action.expected_work_version === initial.work.resume_receipt.cancelled_work_version &&
      action.idempotency_key === initial.work.resume_receipt.idempotency_key) {
    return observed(initial, action, {
      outputs: ['resume idempotent'], operations: ['validate exact resume binding', 'return original ResumeReceipt'],
      receipts: [`ResumeReceipt:${initial.work.resume_receipt.receipt_id}`], terminal: initial.work.state,
    });
  }
  if (!exactWorkBase(initial, action)) return rejected(initial, action, 'control.work_version_stale');
  if (action.idempotency_key !== initial.work?.idempotency_key) {
    return rejected(initial, action, 'control.idempotency_incompatible');
  }
  if (initial.work.state !== 'cancelled' || initial.work.resume_count >= initial.work.resume_ceiling) {
    return rejected(initial, action, 'control.resume_budget_exhausted', {illegal: true, terminal: initial.work.state});
  }
  if (!journalCanAppend(initial)) return rejected(initial, action, 'control.journal_capacity_exhausted', {terminal: 'blocked'});
  const work = {...initial.work, work_version: initial.work.work_version + 1, state: 'queued',
    cancellation_id: null, resume_count: initial.work.resume_count + 1, completion_receipt: null};
  work.resume_receipt = resumeReceiptFor(initial, work, action);
  return observed(initial, action, {
    outputs: ['cancelled work resumed within bound'],
    operations: ['authenticate vault owner', 'compare cancelled Work Item version', 'consume resume budget', 'append resume record'],
    receipts: [`ResumeReceipt:${work.work_id}:${work.resume_count}`], effects: ['append durable resume record'], terminal: 'queued', work,
  });
}

function restart(initial, action) {
  if (!initial.journal_available || !initial.semantic_dependency_available) return rejected(initial, action, 'control.readiness_dependency_unavailable', {terminal: 'blocked'});
  if (!controlChannelIsClosedForStartup(initial)) return rejected(initial, action, 'control.control_channel_state_invalid', {terminal: 'blocked'});
  if (initial.writer_owner_agent_id !== null) return rejected(initial, action, 'control.writer_owner_conflict', {terminal: 'blocked'});
  if (action.expected_journal_head_sequence !== initial.journal_head_sequence) return rejected(initial, action, 'control.journal_head_stale', {terminal: 'blocked'});
  if (action.expected_journal_head_digest !== initial.journal_head_digest) return rejected(initial, action, 'control.journal_head_stale', {terminal: 'blocked'});
  if (action.expected_dependency_state_digest !== initial.dependency_state_digest) return rejected(initial, action, 'control.dependency_base_stale', {terminal: 'blocked'});
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
  if (!controlChannelIsClosedForStartup(initial)) return rejected(initial, action, 'control.control_channel_state_invalid', {terminal: 'blocked'});
  if (initial.writer_owner_agent_id !== null) return rejected(initial, action, 'control.writer_owner_conflict', {terminal: 'blocked'});
  if (action.expected_journal_head_sequence !== initial.journal_head_sequence) return rejected(initial, action, 'control.journal_head_stale', {terminal: 'blocked'});
  if (action.expected_journal_head_digest !== initial.journal_head_digest) return rejected(initial, action, 'control.journal_head_stale', {terminal: 'blocked'});
  if (action.expected_dependency_state_digest !== initial.dependency_state_digest) return rejected(initial, action, 'control.dependency_base_stale', {terminal: 'blocked'});
  if (!writerReceiptIsCurrent(initial, action)) return rejected(initial, action, 'control.writer_receipt_invalid', {terminal: 'blocked'});
  if (!readinessObservationsAreExact(initial, action)) return rejected(initial, action, 'control.readiness_sequence_invalid', {terminal: 'blocked'});
  if (initial.work === null || !exactWorkBase(initial, action)) return rejected(initial, action, 'control.work_version_stale');
  if (['succeeded', 'failed', 'cancelled'].includes(initial.work.state)) {
    return rejected(initial, action, 'control.illegal_transition', {
      illegal: true, terminal: initial.work.state,
    });
  }
  if (!['leased', 'executing'].includes(initial.work.state)) return rejected(initial, action, 'control.recovery_not_required', {illegal: true, terminal: initial.work.state});
  const recoveryStartTick = initial.work.state === 'executing'
    ? latestPriorStartReceipt(
      initial, initial.work, initial.work.lease_id, initial.journal_head_sequence + 1,
    )?.started_tick
    : initial.work.lease_acquired_tick;
  if (action.lease_id !== initial.work.lease_id || initial.work.lease_status !== 'active' ||
      action.recovery_tick === null || action.recovery_tick < recoveryStartTick ||
      action.recovery_tick < initial.work.lease_expires_tick) {
    return rejected(initial, action, 'control.lease_not_recoverable', {terminal: 'blocked'});
  }
  if (action.interruption_count !== initial.work.recovery_interruption_count + 1) {
    return rejected(initial, action, 'control.recovery_count_invalid', {terminal: 'blocked'});
  }
  const recoveryExhausted = action.interruption_count >
    controlPlaneLimits.recoveryInterruptionCeiling;
  const retryExhausted = initial.work.state === 'executing' && initial.work.retry_count >= initial.work.retry_ceiling;
  const nextRecoveryRetryCount = initial.work.retry_count + 1;
  const recoveryRetryDelay = controlPlaneLimits.retryDelays[nextRecoveryRetryCount - 1];
  const retryTickOverflow = initial.work.state === 'executing' &&
    action.recovery_tick + recoveryRetryDelay > controlPlaneLimits.latestDispatchTick;
  if (recoveryExhausted || retryExhausted || retryTickOverflow) {
    if (!journalCanAppend(initial, 2)) return rejected(initial, action, 'control.journal_capacity_exhausted', {terminal: 'blocked'});
    const work = {...initial.work, work_version: initial.work.work_version + 1, state: 'failed',
      retry_eligible_tick: null, recovery_interruption_count: action.interruption_count,
      lease_id: null, lease_status: null, lease_acquired_tick: null, lease_expires_tick: null,
      owner_agent_id: null};
    const recoveryReceipt = recoveryReceiptFor(initial, work, action, 'fail',
      retryTickOverflow ? recoveryRetryDelay : null);
    work.completion_receipt = completionReceiptFor(initial, work, 'failed', null, initial.work.lease_id,
      recoveryExhausted ? 'control.recovery_ceiling_exceeded'
        : retryExhausted ? 'control.retry_ceiling_exceeded' : 'control.retry_tick_overflow', 2, {
        retryable: recoveryExhausted ? null : true,
        observedTick: recoveryExhausted ? null : action.recovery_tick,
        completionTick: action.recovery_tick,
        selectedDelay: retryTickOverflow ? recoveryRetryDelay : null,
      }, intermediateHead(initial, work, [recoveryReceipt]));
    work.completion_history = [...initial.work.completion_history, work.completion_receipt];
    return observed(initial, action, {
      outputs: [recoveryExhausted ? 'recovery interruption ceiling produced terminal failure'
        : retryExhausted ? 'retry ceiling produced terminal failure'
          : 'retry eligibility tick overflow produced terminal failure'],
      operations: ['read Work Journal recovery bases', 'compare recovery and retry ceilings',
        'append Work Recovery record', 'append authenticated terminal completion'],
      receipts: [`WorkRecoveryReceipt:${recoveryReceipt.receipt_id}`,
        `CompletionReceipt:${work.completion_receipt.receipt_id}`],
      effects: ['append durable Work Recovery record', 'append durable terminal completion record'],
      terminal: 'failed', work,
    });
  }
  if (!journalCanAppend(initial)) return rejected(initial, action, 'control.journal_capacity_exhausted', {terminal: 'blocked'});
  const nextState = initial.work.state === 'executing' ? 'retry_wait' : 'queued';
  const nextRetryCount = initial.work.state === 'executing' ? initial.work.retry_count + 1 : initial.work.retry_count;
  const retryDelay = controlPlaneLimits.retryDelays[nextRetryCount - 1];
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

function completeWork(initial, action) {
  const stored = initial.work?.completion_receipt;
  if (initial.work?.state === 'succeeded' && stored?.outcome === 'succeeded' &&
      action.work_id === initial.work.work_id &&
      action.expected_work_version === stored.work_version - 1 &&
      action.lease_id === stored.lease_id && action.idempotency_key === stored.idempotency_key &&
      action.expected_journal_head_sequence === stored.base_head_sequence &&
      action.expected_journal_head_digest === stored.base_head_digest &&
      action.completion_output_digest === stored.output_digest &&
      action.current_tick === stored.completion_tick && validCompletionReceipt(initial, initial.work)) {
    return observed(initial, action, {
      outputs: ['completion idempotent'],
      operations: ['validate exact completion binding', 'return original CompletionReceipt'],
      receipts: [`CompletionReceipt:${stored.receipt_id}`], terminal: 'succeeded',
    });
  }
  if (!exactWorkBase(initial, action)) return rejected(initial, action, 'control.work_version_stale');
  if (action.expected_journal_head_sequence !== initial.journal_head_sequence ||
      action.expected_journal_head_digest !== initial.journal_head_digest) {
    return rejected(initial, action, 'control.journal_head_stale', {terminal: 'blocked'});
  }
  const start = latestPriorStartReceipt(
    initial, initial.work, initial.work?.lease_id, initial.journal_head_sequence + 1,
  );
  if (initial.work?.state !== 'executing' || initial.work.lease_status !== 'active' ||
      action.lease_id !== initial.work.lease_id || action.idempotency_key !== initial.work.idempotency_key ||
      action.completion_output_digest === null || !Number.isInteger(action.current_tick) ||
      start === null || action.current_tick < start.started_tick ||
      action.current_tick >= initial.work.lease_expires_tick) {
    return rejected(initial, action, 'control.precondition_failed', {terminal: initial.work?.state ?? 'rejected'});
  }
  if (!journalCanAppend(initial)) {
    return rejected(initial, action, 'control.journal_capacity_exhausted', {terminal: 'blocked'});
  }
  const work = {...initial.work, work_version: initial.work.work_version + 1, state: 'succeeded',
    retry_eligible_tick: null, lease_id: null, lease_status: null, lease_acquired_tick: null,
    lease_expires_tick: null, owner_agent_id: null};
  work.completion_receipt = completionReceiptFor(
    initial, work, 'succeeded', action.completion_output_digest, initial.work.lease_id,
    null, 1, {completionTick: action.current_tick},
  );
  work.completion_history = [...initial.work.completion_history, work.completion_receipt];
  return observed(initial, action, {
    outputs: ['authenticated completion recorded'],
    operations: ['compare Work Item version', 'compare active Work Lease',
      'validate completion receipt', 'append terminal Work Item result'],
    receipts: [`CompletionReceipt:${work.completion_receipt.receipt_id}`],
    effects: ['append terminal Work Item result'], terminal: 'succeeded', work,
  });
}

function readinessCheck(initial, action) {
  if (!['starting', 'blocked'].includes(initial.agent_state)) {
    return rejected(initial, action, 'control.illegal_transition', {illegal: true, terminal: initial.agent_state});
  }
  if (!controlChannelIsClosedForStartup(initial)) {
    return rejected(initial, action, 'control.control_channel_state_invalid', {terminal: 'blocked'});
  }
  const unavailable = initial.writer_owner_agent_id !== initial.persistent_agent_id ? 'control.readiness_writer_absent'
    : !initial.semantic_dependency_available ? 'control.readiness_semantic_dependency_unavailable'
      : !initial.journal_available ? 'control.readiness_journal_unavailable' : null;
  const failedGate = unavailable === 'control.readiness_writer_absent' ? 'exclusive_writer'
    : unavailable === 'control.readiness_semantic_dependency_unavailable' ? 'semantic_kernel'
      : unavailable === 'control.readiness_journal_unavailable' ? 'work_journal' : null;
  if (unavailable !== 'control.readiness_writer_absent' && !writerReceiptIsRetained(initial, action)) {
    return rejected(initial, action, 'control.writer_receipt_invalid', {terminal: 'blocked'});
  }
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
  if (initial.control_channel.state !== 'open' || !initial.control_channel.same_user_authenticated ||
      !initial.control_channel.local_transport || action.command_vault_id !== initial.vault_id) {
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
  if (initial.control_channel.vault_id !== initial.vault_id) {
    return rejected(initial, action, 'control.vault_binding_invalid', {terminal: 'blocked'});
  }
  if (!journalHeadIsAuthenticated(initial)) return rejected(initial, action, 'control.journal_evidence_invalid', {terminal: 'blocked'});
  if (!dependencyStateIsAuthenticated(initial)) return rejected(initial, action, 'control.dependency_evidence_invalid', {terminal: 'blocked'});
  if (!leaseHistoryIsValid(initial)) return rejected(initial, action, 'control.lease_history_invalid', {terminal: 'blocked'});
  const schedulerTick = action.kind === 'recover' ? action.recovery_tick
    : ['dispatch', 'acknowledge', 'complete_work', 'fail', 'retry', 'cancel'].includes(action.kind)
      ? action.current_tick : initial.scheduler_observed_tick;
  if (!schedulerSnapshotIsConsistent(initial, schedulerTick)) {
    return rejected(initial, action, 'control.scheduler_base_stale', {terminal: 'blocked'});
  }
  if (!workStateIsConsistent(initial.work)) return rejected(initial, action, 'control.work_state_invalid');
  if (initial.work !== null && !validStoredEnqueueReceipt(initial, initial.work)) {
    return rejected(initial, action, 'control.enqueue_receipt_invalid', {terminal: 'blocked'});
  }
  if (['leased', 'executing'].includes(initial.work?.state) &&
      !validPriorLeaseReceipt(initial, initial.work, initial.work.lease_id, initial.journal_head_sequence + 1)) {
    return rejected(initial, action, 'control.lease_receipt_invalid', {terminal: 'blocked'});
  }
  if (initial.work?.state === 'cancelled' && !validStoredCancellationReceipt(initial, initial.work)) {
    return rejected(initial, action, 'control.cancellation_receipt_invalid', {terminal: 'blocked'});
  }
  if (initial.work?.resume_receipt !== null && initial.work?.resume_receipt !== undefined &&
      !validStoredResumeReceipt(initial, initial.work)) {
    return rejected(initial, action, 'control.resume_receipt_invalid', {terminal: 'blocked'});
  }
  if (['cancelled', 'succeeded', 'failed'].includes(initial.work?.state) && !validCompletionReceipt(initial, initial.work)) {
    return rejected(initial, action, 'control.completion_receipt_invalid', {terminal: 'blocked'});
  }
  if (!workHistoryIsAuthenticated(initial, initial.work)) return rejected(initial, action, 'control.work_history_invalid');
  if (action.semantic_write_requested === (action.authority_source === 'none')) return rejected(initial, action, 'control.semantic_authority_binding_invalid');
  if (authorityByAction.get(action.kind) !== action.actor_role) return rejected(initial, action, 'control.actor_authority_denied');
  switch (action.kind) {
    case 'enqueue': return enqueue(initial, action);
    case 'dispatch': return dispatch(initial, action);
    case 'acknowledge': return acknowledge(initial, action);
    case 'complete_work': return completeWork(initial, action);
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
